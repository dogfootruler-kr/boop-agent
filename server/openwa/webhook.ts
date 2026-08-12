/**
 * The `whatsapp` Channel's inbound webhook.
 *
 * This file deliberately holds no policy. Every decision about whether a
 * message may reach Boop is made by `admitInboundWhatsappMessage` in
 * `server/openwa/inbound.ts`, and the handler's only job is to act on that
 * result before it does anything else. Read it top to bottom: the admission
 * call is the first statement, and nothing above it touches Convex or starts
 * an agent.
 *
 * The path is on the public-path allowlist AND additionally restricted to
 * loopback or tailnet source addresses, both in `server/local-access.ts`. Read
 * `docs/adr/0002-inbound-trust-boundary.md`: the signature is not on its own
 * considered sufficient to put an agent, the user's memory, and every
 * connected integration behind.
 */
import express from "express";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { broadcast } from "../broadcast.js";
import { sendToConversation, startTypingForConversation } from "../channels/outbound.js";
import { handleUserMessage } from "../interaction-agent.js";
import { redactContactHandle, redactPhoneNumbers } from "../privacy.js";
import { admitInboundWhatsappMessage, type WhatsappDropReason } from "./inbound.js";
import { WHATSAPP_WEBHOOK_SECRET_HEADER } from "./webhook-auth.js";

export function createWhatsappRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    // The gate. Everything after this point costs something, so nothing before
    // it may: no dedup claim, no Convex write, no agent.
    const admission = await admitInboundWhatsappMessage({
      signature: req.get(WHATSAPP_WEBHOOK_SECRET_HEADER),
      body: req.body,
    });
    if (!admission.admitted) {
      respondToDrop(res, admission.reason);
      return;
    }

    const { handle, conversationId, externalMessageId, text } = admission.message;

    if (externalMessageId) {
      const { claimed } = await convex.mutation(api.channelDedup.claim, {
        channel: "whatsapp",
        externalMessageId,
      });
      if (!claimed) {
        res.json({ ok: true, deduped: true });
        return;
      }
    }

    const turnTag = Math.random().toString(36).slice(2, 8);
    const safeText = redactPhoneNumbers(text);
    const preview = safeText.length > 100 ? safeText.slice(0, 100) + "…" : safeText;
    console.log(`[turn ${turnTag}] ← ${redactContactHandle(handle)}: ${JSON.stringify(preview)}`);
    const start = Date.now();

    broadcast("message_in", { conversationId, content: text });
    // Answered before the turn runs: the Gateway would otherwise retry a
    // message that is already being worked on.
    res.json({ ok: true });

    const stopTyping = startTypingForConversation(conversationId);
    try {
      const reply = await handleUserMessage({
        conversationId,
        content: text,
        turnTag,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const safeReply = redactPhoneNumbers(reply);
        const replyPreview = safeReply.length > 100 ? safeReply.slice(0, 100) + "…" : safeReply;
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        await sendToConversation(conversationId, reply);
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: reply,
        });
      } else {
        console.log(`[turn ${turnTag}] → (no reply)`);
      }
    } catch (err) {
      console.error(`[turn ${turnTag}] handler error`, err);
    } finally {
      stopTyping();
    }
  });

  return router;
}

/**
 * Answer a dropped call.
 *
 * A failed signature is the one case worth a 401: it is the only reason that
 * says something about the caller rather than about the message. Every other
 * drop answers 200, because the Gateway retries on an error status and a
 * message Boop deliberately refused must not come back.
 */
function respondToDrop(res: express.Response, reason: WhatsappDropReason): void {
  if (reason === "unsigned" || reason === "bad-signature") {
    res.status(401).json({ error: "invalid webhook signature" });
    return;
  }
  res.json({ ok: true, dropped: reason });
}
