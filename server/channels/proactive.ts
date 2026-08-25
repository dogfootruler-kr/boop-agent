/**
 * The Conversation Boop reaches the user on when it starts the conversation
 * itself.
 *
 * Everything else outbound already has a Conversation ID to answer on: an
 * inbound message arrived on a Channel and the reply goes back the same way.
 * A proactive email notice has no such thread, so the Conversation has to be
 * configured, and before this existed it was assembled as `sms:<phone>` at the
 * one place that needed it. That hardcoded prefix made stories 8 and 9
 * unreachable for someone who only uses WhatsApp.
 *
 * It is one configured value rather than a branch per send site, so a Channel
 * added later is reachable proactively without editing anything here.
 */
import { CHANNEL_KEYS, isChannelKey, type ChannelKey } from "./registry.js";

/** Which Channel proactive messages go out on. */
export const PROACTIVE_CHANNEL_ENV = "BOOP_PROACTIVE_CHANNEL";

/** The user's own address, in whichever form they wrote it. */
export const PROACTIVE_HANDLE_ENV = "BOOP_USER_PHONE";

/**
 * iMessage, which is the only Channel that existed when this was configured
 * as a bare phone number. Someone who has only ever used iMessage sets
 * nothing and keeps exactly the behaviour they had.
 */
const DEFAULT_PROACTIVE_CHANNEL: ChannelKey = "sms";

/**
 * The Conversation ID a proactive message is delivered on, or null when it is
 * not configured well enough to deliver anywhere.
 *
 * Null is loud: every reason for it is logged here, so a caller only has to
 * decide whether to skip, not to explain.
 */
export function proactiveConversationId(): string | null {
  const channelKey = proactiveChannelKey();
  if (!channelKey) return null;
  const handle = proactiveHandle(channelKey);
  if (!handle) return null;
  return `${channelKey}:${handle}`;
}

function proactiveChannelKey(): ChannelKey | null {
  const raw = process.env[PROACTIVE_CHANNEL_ENV]?.trim();
  if (!raw) return DEFAULT_PROACTIVE_CHANNEL;
  if (isChannelKey(raw)) return raw;
  // Deliberately not a fallback to the default: a typo would then deliver
  // urgent mail to a Channel the user is not looking at, which is the exact
  // thing configuring this is supposed to prevent.
  console.warn(
    `[proactive] ${PROACTIVE_CHANNEL_ENV}=${JSON.stringify(raw)} is not a channel ` +
      `(${CHANNEL_KEYS.join(", ")}); skipping dispatch`,
  );
  return null;
}

/**
 * Bring whatever the user put in `BOOP_USER_PHONE` to a Handle on `channelKey`.
 *
 * A Handle is E.164 on the two Channels addressed by phone number, and the
 * normalization matters: without it a bare 10-digit number in env produces an
 * `sms:NNNNNNNNNN` conversation that doesn't match the `sms:+1NNNNNNNNNN` ID
 * the Gateway uses for inbound messages from the same person, and proactive
 * notices end up in a parallel Convex conversation invisible to the
 * user-driven thread.
 *
 * Telegram is the exception that makes this take a Channel at all: it
 * addresses a chat by numeric chat ID, not by phone number, so E.164
 * normalization there would produce a Conversation ID that matches nothing
 * inbound and a `sendMessage` that Telegram answers with "chat not found".
 * The env var keeps its phone-shaped name because renaming it would break
 * every existing `.env.local` for no behavioural gain.
 */
function proactiveHandle(channelKey: ChannelKey): string | null {
  const raw = process.env[PROACTIVE_HANDLE_ENV];
  if (!raw?.trim()) {
    console.warn(`[proactive] ${PROACTIVE_HANDLE_ENV} not set; skipping dispatch`);
    return null;
  }
  const trimmed = raw.trim();

  if (channelKey === "telegram") {
    // Negative for a group; kept verbatim, because a chat ID is an opaque
    // identifier rather than a number with a canonical form.
    if (/^-?\d+$/.test(trimmed)) return trimmed;
    console.warn(
      `[proactive] ${PROACTIVE_HANDLE_ENV}=${JSON.stringify(raw)} is not a Telegram chat ID; ` +
        `on the telegram channel this must be the numeric chat ID, not a phone number. Skipping dispatch`,
    );
    return null;
  }

  if (trimmed.startsWith("+")) return trimmed;
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`;
  console.warn(
    `[proactive] ${PROACTIVE_HANDLE_ENV}=${JSON.stringify(raw)} doesn't look like a valid phone number; skipping dispatch`,
  );
  return null;
}
