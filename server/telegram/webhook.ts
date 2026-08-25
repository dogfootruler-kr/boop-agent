/**
 * The `telegram` Channel's inbound webhook.
 *
 * This file deliberately holds no policy. Every decision about whether a
 * message may reach Boop is made by `admitInboundTelegramMessage` in
 * `server/telegram/inbound.ts`, and the handler's only job is to act on that
 * result before it does anything else. Read it top to bottom: the admission
 * call is the first statement, and nothing above it touches Convex or starts
 * an agent.
 *
 * Unlike WhatsApp's path this one is reachable from the public internet -
 * Telegram's servers call it, not a gateway on the user's own tailnet - so it
 * is on the public-path allowlist in `server/local-access.ts` without the
 * additional source-address restriction, exactly like Sendblue's. The secret
 * token and the Allowlist are therefore the entire trust boundary; see
 * `docs/adr/0002-inbound-trust-boundary.md`.
 */
import express from "express";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { broadcast } from "../broadcast.js";
import { startTypingForConversation } from "../channels/outbound.js";
import { deliverAssistantMessage } from "../channels/delivery.js";
import { handleUserMessage } from "../interaction-agent.js";
import { redactContactHandle, redactPhoneNumbers } from "../privacy.js";
import { maybeHandleScriptedDemoReply } from "../scripted-demo-replies.js";
import { admitInboundTelegramMessage, type TelegramDropReason } from "./inbound.js";
import { ingestTelegramImage } from "./media.js";
import { TELEGRAM_WEBHOOK_SECRET_HEADER } from "./webhook-auth.js";

export function createTelegramRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    // The gate. Everything after this point costs something, so nothing before
    // it may: no dedup claim, no Convex write, no agent.
    const admission = admitInboundTelegramMessage({
      secretToken: req.get(TELEGRAM_WEBHOOK_SECRET_HEADER),
      body: req.body,
    });
    if (!admission.admitted) {
      respondToDrop(res, admission.reason);
      return;
    }

    const { handle, conversationId, externalMessageId, text, photoFileId } = admission.message;

    const { claimed } = await convex.mutation(api.channelDedup.claim, {
      channel: "telegram",
      externalMessageId,
    });
    if (!claimed) {
      res.json({ ok: true, deduped: true });
      return;
    }

    // Fetching media is expensive and authenticated, so it happens here,
    // strictly after admission and the dedup claim, never inside the gate.
    let images: Array<{ storageId: string; mediaType: string }> = [];
    let mediaError: string | undefined;
    if (photoFileId) {
      const ingested = await ingestTelegramImage(photoFileId);
      if (ingested.ok) images = [ingested.image];
      else mediaError = ingested.reason;
    }

    const turnTag = Math.random().toString(36).slice(2, 8);
    const safeText = redactPhoneNumbers(text);
    const preview = safeText.length > 100 ? safeText.slice(0, 100) + "…" : safeText;
    console.log(`[turn ${turnTag}] ← ${redactContactHandle(handle)}: ${JSON.stringify(preview)}`);
    const start = Date.now();

    broadcast("message_in", { conversationId, content: text });
    // Answered before the turn runs: Telegram re-delivers an update whose
    // webhook call did not return 200, and a message already being worked on
    // must not come back.
    res.json({ ok: true });

    if (
      await maybeHandleScriptedDemoReply({
        conversationId,
        content: text,
        turnTag,
      })
    ) {
      return;
    }

    const stopTyping = startTypingForConversation(conversationId);
    try {
      const reply = await handleUserMessage({
        conversationId,
        content: text,
        turnTag,
        images,
        mediaError,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const safeReply = redactPhoneNumbers(reply);
        const replyPreview = safeReply.length > 100 ? safeReply.slice(0, 100) + "…" : safeReply;
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        // Recorded only if it went out: a reply nobody received must not
        // appear on the dashboard as one the user got.
        await deliverAssistantMessage(conversationId, reply);
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
 * A failed secret token is the one case worth a 401: it is the only reason
 * that says something about the caller rather than about the message. Every
 * other drop answers 200, because Telegram re-delivers an update on any other
 * status and a message Boop deliberately refused must not come back.
 */
function respondToDrop(res: express.Response, reason: TelegramDropReason): void {
  if (reason === "unsigned" || reason === "bad-signature") {
    res.status(401).json({ error: "invalid webhook secret token" });
    return;
  }
  res.json({ ok: true, dropped: reason });
}
