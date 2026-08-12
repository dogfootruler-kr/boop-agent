/**
 * The `sms` Channel: Apple iMessage with Sendblue as its Gateway.
 *
 * The name is slightly inaccurate for a channel that is mostly iMessage. It is
 * kept because the Gateway really does fall back to SMS for non-Apple
 * recipients, and because renaming it would cost a data migration of every
 * historical Conversation ID and buy nothing.
 */
import {
  formatForImessage,
  isSendblueConfigured,
  sendSendbluePart,
  startTypingLoop,
} from "../sendblue.js";
import { registerChannel, type Channel } from "./registry.js";

export const smsChannel: Channel = {
  key: "sms",
  formatOutbound: (text) => formatForImessage(text),
  send: (handle, part) => sendSendbluePart(handle, part),
  startTyping: (handle) => startTypingLoop(handle),
};

/**
 * Register the `sms` channel, but only when its Gateway is configured.
 *
 * Without credentials the channel is absent, so an outbound send resolves to
 * nothing and says so once, rather than resolving to an adapter that fails on
 * every call.
 */
export function registerSmsChannel(): void {
  if (!isSendblueConfigured()) {
    console.warn(
      "[channels] sms not configured (SENDBLUE_API_KEY / SENDBLUE_API_SECRET missing) - skipping",
    );
    return;
  }
  registerChannel(smsChannel);
}
