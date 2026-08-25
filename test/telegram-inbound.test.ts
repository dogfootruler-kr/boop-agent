import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitInboundTelegramMessage,
  type TelegramAdmission,
} from "../server/telegram/inbound.js";
import {
  deriveTelegramWebhookSecret,
  verifyTelegramWebhookSecret,
} from "../server/telegram/webhook-auth.js";

// Placeholder values only - this is a public repo.
const BOT_TOKEN = `123456789:${"A".repeat(35)}`;
const SECRET = deriveTelegramWebhookSecret(BOT_TOKEN);
const OWNER_CHAT_ID = "111222333";
const STRANGER_CHAT_ID = "444555666";
const GROUP_CHAT_ID = "-1001234567890";

const TELEGRAM_ENV = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWLIST"] as const;
const originalEnv = new Map(TELEGRAM_ENV.map((key) => [key, process.env[key]]));

function configureTelegram(allowlist = OWNER_CHAT_ID): void {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_ALLOWLIST = allowlist;
}

/** The envelope shape the Bot API delivers, with only the message varied. */
function update(message: Record<string, unknown> | undefined, updateId = 1001) {
  return { update_id: updateId, ...(message ? { message } : {}) };
}

function textMessage(overrides: Record<string, unknown> = {}) {
  return update({
    message_id: 7,
    from: { id: Number(OWNER_CHAT_ID), is_bot: false, username: "owner_handle" },
    chat: { id: Number(OWNER_CHAT_ID), type: "private" },
    date: 1700000000,
    text: "hello",
    ...overrides,
  });
}

/** A call carrying the secret token the webhook is registered with. */
function signed(body: unknown): TelegramAdmission {
  return admitInboundTelegramMessage({ secretToken: SECRET, body });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  configureTelegram();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("telegram webhook secret", () => {
  it("derives the same secret from the same bot token", () => {
    expect(deriveTelegramWebhookSecret(BOT_TOKEN)).toBe(SECRET);
  });

  it("produces a secret Telegram's own `secret_token` rule accepts", () => {
    expect(SECRET).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
  });

  it("rotates the secret when the bot token rotates", () => {
    expect(deriveTelegramWebhookSecret(`${BOT_TOKEN}x`)).not.toBe(SECRET);
  });

  it("rejects a secret derived from a different token", () => {
    expect(verifyTelegramWebhookSecret(deriveTelegramWebhookSecret("other"), BOT_TOKEN)).toBe(
      false,
    );
  });

  it("rejects verification when no bot token is configured", () => {
    // The argument is omitted, not passed as undefined: an explicit undefined
    // falls through to the default and reads the env var back out again.
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(verifyTelegramWebhookSecret(SECRET)).toBe(false);
  });
});

describe("admitInboundTelegramMessage", () => {
  it("admits an allowlisted private message", () => {
    const result = signed(textMessage());
    expect(result).toMatchObject({
      admitted: true,
      message: {
        handle: OWNER_CHAT_ID,
        conversationId: `telegram:${OWNER_CHAT_ID}`,
        externalMessageId: "1001",
        text: "hello",
      },
    });
  });

  it("drops a call with no secret token", () => {
    const result = admitInboundTelegramMessage({ secretToken: undefined, body: textMessage() });
    expect(result).toEqual({ admitted: false, reason: "unsigned" });
  });

  it("drops a call whose secret token is wrong", () => {
    const result = admitInboundTelegramMessage({ secretToken: "nope", body: textMessage() });
    expect(result).toEqual({ admitted: false, reason: "bad-signature" });
  });

  it("checks the secret before anything else, even on a malformed body", () => {
    const result = admitInboundTelegramMessage({ secretToken: "nope", body: null });
    expect(result).toEqual({ admitted: false, reason: "bad-signature" });
  });

  it("drops an update that is not a new message", () => {
    expect(signed(update(undefined))).toEqual({ admitted: false, reason: "not-a-message" });
  });

  it("drops a message from a bot, which is how a self-reply loop is prevented", () => {
    const result = signed(
      textMessage({ from: { id: 999, is_bot: true, username: "boop_bot" } }),
    );
    expect(result).toEqual({ admitted: false, reason: "bot-message" });
  });

  it("drops a group message even when the sender is allowlisted", () => {
    const result = signed(
      textMessage({ chat: { id: Number(GROUP_CHAT_ID), type: "supergroup" } }),
    );
    expect(result).toEqual({ admitted: false, reason: "group" });
  });

  it("drops a sender that is not on the allowlist", () => {
    const result = signed(
      textMessage({
        from: { id: Number(STRANGER_CHAT_ID), is_bot: false },
        chat: { id: Number(STRANGER_CHAT_ID), type: "private" },
      }),
    );
    expect(result).toEqual({ admitted: false, reason: "not-allowlisted" });
  });

  it("drops everyone when the allowlist is empty, rather than admitting everyone", () => {
    configureTelegram("");
    expect(signed(textMessage())).toEqual({ admitted: false, reason: "not-allowlisted" });
  });

  it("admits on a @username entry, case-insensitively", () => {
    configureTelegram("@Owner_Handle");
    expect(signed(textMessage())).toMatchObject({ admitted: true });
  });

  it("drops a message with neither text nor media", () => {
    const result = signed(textMessage({ text: undefined }));
    expect(result).toEqual({ admitted: false, reason: "empty" });
  });

  it("admits a photo with no caption and reports its largest rendition", () => {
    const result = signed(
      textMessage({
        text: undefined,
        photo: [
          { file_id: "small", width: 90 },
          { file_id: "large", width: 1280 },
        ],
      }),
    );
    expect(result).toMatchObject({ admitted: true, message: { text: "", photoFileId: "large" } });
  });

  it("uses the caption as the text of a photo message", () => {
    const result = signed(
      textMessage({ text: undefined, caption: "look", photo: [{ file_id: "only" }] }),
    );
    expect(result).toMatchObject({ admitted: true, message: { text: "look" } });
  });

  it("admits a voice note with no text and carries its descriptor", () => {
    const result = signed(
      textMessage({
        text: undefined,
        voice: { file_id: "voice-1", duration: 7, mime_type: "audio/ogg", file_size: 9001 },
      }),
    );
    expect(result).toMatchObject({
      admitted: true,
      message: {
        text: "",
        voice: { fileId: "voice-1", mimeType: "audio/ogg", durationSeconds: 7 },
      },
    });
  });

  it("admits an attached audio file the same way as a held-button voice note", () => {
    // A voice memo forwarded from another app arrives as `audio`, not `voice`.
    const result = signed(
      textMessage({ text: undefined, audio: { file_id: "audio-1", duration: 42 } }),
    );
    expect(result).toMatchObject({
      admitted: true,
      message: { voice: { fileId: "audio-1", durationSeconds: 42 } },
    });
  });

  it("keeps the caption alongside a voice descriptor rather than choosing between them", () => {
    const result = signed(
      textMessage({ text: undefined, caption: "listen to this", audio: { file_id: "a" } }),
    );
    expect(result).toMatchObject({
      admitted: true,
      message: { text: "listen to this", voice: { fileId: "a" } },
    });
  });

  it("admits an over-long voice note, leaving the duration cap to the caller", () => {
    // Dropping it here would be silent, and a voice note that vanishes without
    // a reply is the one outcome the voice path must not produce.
    const result = signed(
      textMessage({ text: undefined, voice: { file_id: "long", duration: 60 * 60 } }),
    );
    expect(result).toMatchObject({ admitted: true, message: { voice: { durationSeconds: 3600 } } });
  });

  it("does not treat a video note as something to transcribe", () => {
    const result = signed(
      textMessage({ text: undefined, video_note: { file_id: "round", duration: 5 } }),
    );
    expect(result).toEqual({ admitted: false, reason: "empty" });
  });

  it("ignores a voice object with no file_id", () => {
    const result = signed(textMessage({ text: undefined, voice: { duration: 3 } }));
    expect(result).toEqual({ admitted: false, reason: "empty" });
  });

  it("still refuses a voice note from someone off the allowlist", () => {
    const result = signed(
      textMessage({
        text: undefined,
        from: { id: Number(STRANGER_CHAT_ID), is_bot: false },
        chat: { id: Number(STRANGER_CHAT_ID), type: "private" },
        voice: { file_id: "voice-1" },
      }),
    );
    expect(result).toEqual({ admitted: false, reason: "not-allowlisted" });
  });

  it("keeps a chat ID beyond Number.MAX_SAFE_INTEGER exact by carrying it as a string", () => {
    // Telegram IDs are within 52 bits today, but the handle is the routing key
    // for every reply, so it must never be re-derived through a lossy Number.
    const huge = "9007199254740993";
    configureTelegram(huge);
    const result = signed(
      textMessage({ from: { id: 1, is_bot: false }, chat: { id: huge, type: "private" } }),
    );
    expect(result).toMatchObject({
      admitted: true,
      message: { handle: huge, conversationId: `telegram:${huge}` },
    });
  });
});
