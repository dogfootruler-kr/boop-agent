/**
 * The one place that knows how to send a message.
 *
 * Every outbound path routes here with a Conversation ID, so a send site does
 * not know or care which Channel it is talking on, and a Channel added later
 * is reachable from all of them without editing any of them.
 */
import { redactPhoneNumbers } from "../privacy.js";
import {
  isChannelKey,
  parseConversationId,
  resolveChannel,
  type StopTyping,
} from "./registry.js";

const NO_TYPING: StopTyping = () => {};

/**
 * Send `text` on whichever Channel the Conversation ID belongs to.
 *
 * Returns false when the conversation has no Channel, which is the normal case
 * for threads that are not a messaging transport at all.
 */
export async function sendToConversation(
  conversationId: string,
  text: string,
): Promise<boolean> {
  const target = resolveChannel(conversationId);
  if (!target) {
    warnUnroutable(conversationId);
    return false;
  }
  // Intentional privacy guard, and the reason it lives here instead of in an
  // adapter: redaction runs above per-channel formatting, so no adapter can be
  // written that delivers a phone number by skipping it.
  const safe = redactPhoneNumbers(text);
  for (const part of target.channel.formatOutbound(safe)) {
    await target.channel.send(target.handle, part);
  }
  return true;
}

/**
 * Show a typing indication on the Conversation's Channel.
 *
 * Always returns a stop function, so a caller's `finally` needs no branch for
 * a conversation with no Channel.
 */
export function startTypingForConversation(conversationId: string): StopTyping {
  const target = resolveChannel(conversationId);
  if (!target) return NO_TYPING;
  return target.channel.startTyping(target.handle);
}

function warnUnroutable(conversationId: string): void {
  const parsed = parseConversationId(conversationId);
  // A Conversation ID whose prefix is not a channel key was never going
  // anywhere. Only a real channel with no adapter registered is worth saying
  // out loud, because that one is a configuration problem.
  if (parsed && isChannelKey(parsed.channelKey)) {
    console.warn(`[channels] no ${parsed.channelKey} adapter registered - not sending`);
  }
}
