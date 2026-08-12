/**
 * Delivering a message Boop wrote, and recording what was delivered.
 *
 * Every send site used to do this by hand: send, then write the same text to
 * Convex as `role: "assistant"`. The write ran whether or not the send did,
 * so a message that reached nobody - the Conversation's Channel is not
 * registered, because its Gateway is not configured - still appeared in Convex
 * and on the debug dashboard as a message the user had received.
 *
 * This is the one place that decides that, so a send site cannot record a
 * delivery that did not happen by forgetting to check.
 */
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { sendToConversation } from "./outbound.js";

/**
 * Send `content` on the Conversation's Channel and, only if it went out,
 * record it as Boop's own message.
 *
 * Returns whether it was delivered, for callers that log a turn.
 */
export async function deliverAssistantMessage(
  conversationId: string,
  content: string,
): Promise<boolean> {
  const delivered = await sendToConversation(conversationId, content);
  if (!delivered) {
    console.error(
      `[channels] ${conversationId} has no channel to deliver on - the message was NOT recorded, ` +
        "because storing it would show it on the dashboard as one the user received",
    );
    return false;
  }
  await convex.mutation(api.messages.send, {
    conversationId,
    role: "assistant",
    content,
  });
  return true;
}
