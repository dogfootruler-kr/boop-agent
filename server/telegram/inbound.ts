/**
 * The `telegram` Channel's admission gate.
 *
 * Every decision about whether an inbound update may become an agent turn is
 * made here, and `server/telegram/webhook.ts` holds none of it. The ordering
 * matters and is the same as WhatsApp's gate: authenticate the caller first,
 * then establish who is speaking, then decide whether they are allowed to.
 *
 * Unlike the WhatsApp Gateway, Telegram's is a public cloud service that
 * reaches Boop over the internet, so there is no network-level trust boundary
 * behind this - the secret token and the Allowlist are the whole boundary.
 * That is why the Allowlist is not optional: an empty one drops everything
 * rather than admitting everyone. Read `docs/adr/0002-inbound-trust-boundary.md`.
 */
import { loadTelegramConfig } from "./config.js";
import { verifyTelegramWebhookSecret } from "./webhook-auth.js";

/** Why an update did not become an agent turn. */
export type TelegramDropReason =
  /** No secret-token header on the request at all. */
  | "unsigned"
  /** A secret token that is not the one Boop registered. */
  | "bad-signature"
  /** Not the envelope shape the Bot API is supposed to send. */
  | "malformed"
  /** An update Boop does not act on: an edit, a reaction, a poll answer. */
  | "not-a-message"
  /** A message from a bot, including Boop's own. */
  | "bot-message"
  /** A group or channel. Being added to one must not make every message a turn. */
  | "group"
  /** A sender that is not on the Allowlist. */
  | "not-allowlisted"
  /** Nothing to answer: no text, no caption, no supported media. */
  | "empty";

/**
 * A voice note or audio file on an inbound message, before it is downloaded.
 *
 * Carried out of the gate as a descriptor rather than as bytes for the same
 * reason a photo is: resolving a `file_id` is an authenticated round trip and
 * transcribing is slower still, so neither may happen until the message has
 * been admitted and the dedup claim has been won.
 */
export interface InboundTelegramVoice {
  readonly fileId: string;
  /** The type Telegram declared. Used when the download itself does not say. */
  readonly mimeType?: string;
  /** Length in whole seconds, as Telegram reports it. Absent if it did not. */
  readonly durationSeconds?: number;
}

/** An inbound message that has passed every gate and may now cost something. */
export interface AdmittedTelegramMessage {
  /** The chat ID, as a string. Also the Handle for this Channel. */
  readonly handle: string;
  /** `telegram:<chat_id>`, the routing key for the reply. */
  readonly conversationId: string;
  /** The update ID, for the dedup claim. */
  readonly externalMessageId: string;
  /** The message text, or its caption when it carried one. May be empty on a media message. */
  readonly text: string;
  /**
   * The `file_id` of the largest photo on the message, when it carried one.
   *
   * Resolving it to bytes is expensive and authenticated, so it stays out of
   * this gate entirely: the caller fetches it strictly after admission and the
   * dedup claim.
   */
  readonly photoFileId?: string;
  /**
   * The voice note or audio file on the message, when it carried one.
   *
   * A descriptor only; see `InboundTelegramVoice`. Note that this gate does
   * not enforce the duration cap - an over-long note is admitted so that the
   * caller can answer the user saying so, which a silent drop could not do.
   */
  readonly voice?: InboundTelegramVoice;
  /** The sender's `@username`, when they have one. Logging and diagnostics only. */
  readonly username?: string;
}

export type TelegramAdmission =
  | { admitted: true; message: AdmittedTelegramMessage }
  | { admitted: false; reason: TelegramDropReason };

/** One webhook call, reduced to the two things admission depends on. */
export interface InboundTelegramCall {
  /** The `X-Telegram-Bot-Api-Secret-Token` header, or undefined when absent. */
  readonly secretToken: string | undefined;
  /** The parsed JSON body, untrusted and of unknown shape. */
  readonly body: unknown;
}

/**
 * Decide whether an inbound webhook call may become an agent turn.
 *
 * Callers must act on the result before claiming dedup, before writing
 * anything to Convex, and before spawning an agent.
 */
export function admitInboundTelegramMessage(call: InboundTelegramCall): TelegramAdmission {
  const config = loadTelegramConfig();
  if (!config) return drop("malformed");

  // 1. Secret token. Nothing below this line runs for a call Boop cannot
  //    attribute to the Gateway it registered with.
  if (!call.secretToken) return drop("unsigned");
  if (!verifyTelegramWebhookSecret(call.secretToken, config.botToken)) {
    // Worth seeing: a wrong token is either a forged call or a webhook still
    // registered against a stale secret, and both go silent otherwise.
    console.warn("[telegram] rejected a webhook call with a bad secret token");
    return drop("bad-signature");
  }

  // 2. Envelope. Only ordinary new messages are acted on; an edited message,
  //    a reaction, or a channel post is not a new thing to answer.
  const update = call.body;
  if (!isRecord(update)) return drop("malformed");
  const updateId = update.update_id;
  if (typeof updateId !== "number") return drop("malformed");
  const message = update.message;
  if (!isRecord(message)) return drop("not-a-message");

  // 3. Who is speaking. A bot's message is never a turn - that includes
  //    Boop's own, which is what stops a self-reply loop.
  const from = isRecord(message.from) ? message.from : undefined;
  if (from?.is_bot === true) return drop("bot-message");

  const chat = message.chat;
  if (!isRecord(chat)) return drop("malformed");
  if (chat.type !== "private") return drop("group");
  const chatId = chat.id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return drop("malformed");
  const handle = String(chatId);

  // 4. The Allowlist. An unconfigured Allowlist drops rather than admits, and
  //    the chat ID is logged so it can be copied straight into it: a Telegram
  //    chat ID is not something a user can look up for themselves easily.
  const username = typeof from?.username === "string" ? from.username : undefined;
  if (!isAllowlisted(handle, username, config)) {
    console.warn(
      `[telegram] dropped a message from chat ${handle}${username ? ` (@${username})` : ""} - not on TELEGRAM_ALLOWLIST`,
    );
    return drop("not-allowlisted");
  }

  // 5. Something to answer.
  const text = firstString(message.text, message.caption) ?? "";
  const photoFileId = largestPhotoFileId(message.photo);
  const voice = inboundVoice(message);
  if (!text && !photoFileId && !voice) return drop("empty");

  return {
    admitted: true,
    message: {
      handle,
      conversationId: `telegram:${handle}`,
      externalMessageId: String(updateId),
      text,
      photoFileId,
      voice,
      username,
    },
  };
}

/**
 * The voice note or audio file on an inbound message, if there is one.
 *
 * Telegram splits these across two fields: `voice` is a note recorded by
 * holding the microphone button, `audio` is a file that was attached. Both are
 * someone speaking as far as Boop is concerned - a voice memo forwarded from
 * another app arrives as `audio` - so both are accepted. `video_note` is not:
 * it is a video, and nothing downstream would look at the picture.
 */
function inboundVoice(message: Record<string, unknown>): InboundTelegramVoice | undefined {
  const media = isRecord(message.voice)
    ? message.voice
    : isRecord(message.audio)
      ? message.audio
      : undefined;
  if (!media || typeof media.file_id !== "string" || !media.file_id) return undefined;
  return {
    fileId: media.file_id,
    mimeType: typeof media.mime_type === "string" ? media.mime_type : undefined,
    durationSeconds: typeof media.duration === "number" ? media.duration : undefined,
  };
}

/**
 * The `file_id` of the largest rendition of an inbound photo.
 *
 * Telegram sends a photo as an array of renditions ordered smallest first, so
 * the last entry is the highest resolution available. The size cap that
 * matters is enforced downstream while streaming the download, not here.
 */
function largestPhotoFileId(photo: unknown): string | undefined {
  if (!Array.isArray(photo) || photo.length === 0) return undefined;
  const largest = photo[photo.length - 1];
  if (!isRecord(largest) || typeof largest.file_id !== "string") return undefined;
  return largest.file_id;
}

function isAllowlisted(
  handle: string,
  username: string | undefined,
  config: NonNullable<ReturnType<typeof loadTelegramConfig>>,
): boolean {
  if (config.allowedChatIds.has(handle)) return true;
  return Boolean(username && config.allowedUsernames.has(username.toLowerCase()));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function drop(reason: TelegramDropReason): TelegramAdmission {
  return { admitted: false, reason };
}
