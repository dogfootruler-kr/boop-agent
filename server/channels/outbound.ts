/**
 * The one place that knows how to send a message.
 *
 * Every outbound path routes here with a Conversation ID, so a send site does
 * not know or care which Channel it is talking on, and a Channel added later
 * is reachable from all of them without editing any of them.
 */
import { redactPhoneNumbersThroughMarkup } from "../privacy.js";
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
  //
  // It runs twice, on either side of formatting, because those are two
  // different guarantees and neither implies the other. Before, the whole
  // reply is intact, so a number a chunk boundary would later split is still
  // one number. After, the text is what `Channel.send` is about to put on the
  // wire, which is the only text the guarantee is actually about: formatting
  // rewrites markup, and `+1 555 **000** 0101` becomes a whole phone number
  // the moment an adapter strips those markers.
  const safe = redactPhoneNumbersThroughMarkup(text);
  for (const part of target.channel.formatOutbound(safe)) {
    await target.channel.send(target.handle, redactPhoneNumbersThroughMarkup(part));
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
