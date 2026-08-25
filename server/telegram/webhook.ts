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
import { MAX_AUDIO_SECONDS } from "../audio/mime.js";
import type {
  TranscriptionFailure,
  TranscriptionProvider,
  TranscriptionRecord,
} from "../audio/transcribe.js";
import {
  admitInboundTelegramMessage,
  type InboundTelegramVoice,
  type TelegramDropReason,
} from "./inbound.js";
import { ingestTelegramImage } from "./media.js";
import { transcribeTelegramVoice } from "./voice.js";
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

    const { handle, conversationId, externalMessageId, text, photoFileId, voice } =
      admission.message;

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
    const start = Date.now();

    // Answered before anything slow runs: Telegram re-delivers an update whose
    // webhook call did not return 200, and a message already being worked on
    // must not come back. Transcribing a voice note can take tens of seconds,
    // so the acknowledgement goes out ahead of it rather than after.
    res.json({ ok: true });

    // Started here rather than alongside the agent because transcription is
    // the slowest part of a voice turn, and it is exactly the stretch during
    // which the user has no idea whether their note landed.
    const stopTyping = startTypingForConversation(conversationId);
    try {
      let content = text;
      let transcription: TranscriptionRecord | undefined;
      if (voice) {
        const heard = await transcribeVoice(voice, turnTag);
        if (!heard.ok) {
          await deliverAssistantMessage(conversationId, heard.reply);
          return;
        }
        transcription = heard.record;
        // A caption is kept and put first: on an `audio` message it is what
        // the user typed about the thing they are sending, which frames the
        // recording rather than being replaced by it.
        content = text ? `${text}\n\n${heard.transcript}` : heard.transcript;
      }

      const safeText = redactPhoneNumbers(content);
      const preview = safeText.length > 100 ? safeText.slice(0, 100) + "…" : safeText;
      // The model is named because the log is where a transcript that came
      // back as nonsense is diagnosed, and the answer is nearly always which
      // model heard it.
      const heardVia = transcription ? ` (voice via ${transcription.model})` : "";
      console.log(
        `[turn ${turnTag}] ← ${redactContactHandle(handle)}${heardVia}: ${JSON.stringify(preview)}`,
      );
      broadcast("message_in", { conversationId, content });

      if (
        await maybeHandleScriptedDemoReply({
          conversationId,
          content,
          turnTag,
        })
      ) {
        return;
      }

      const reply = await handleUserMessage({
        conversationId,
        content,
        turnTag,
        images,
        mediaError,
        transcription,
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
 * Transcribe an admitted voice note, or produce the sentence to say instead.
 *
 * Every failure ends in something the user actually receives. A voice note is
 * an act of trust in a way a text is not - there is no local copy of what was
 * said and no way to tell from the outside that it went nowhere - so silence
 * is the one outcome this must never produce.
 */
async function transcribeVoice(
  voice: InboundTelegramVoice,
  turnTag: string,
): Promise<
  { ok: true; transcript: string; record: TranscriptionRecord } | { ok: false; reply: string }
> {
  if (voice.durationSeconds !== undefined && voice.durationSeconds > MAX_AUDIO_SECONDS) {
    const minutes = Math.floor(MAX_AUDIO_SECONDS / 60);
    console.log(`[turn ${turnTag}] voice note is ${voice.durationSeconds}s - over the cap`);
    return {
      ok: false,
      reply: `That one's a bit long for me - I can listen to about ${minutes} minutes at a time. Mind sending a shorter note?`,
    };
  }

  const result = await transcribeTelegramVoice(voice.fileId, voice.mimeType);
  if (result.ok) {
    return {
      ok: true,
      transcript: result.text,
      record: {
        provider: result.provider,
        model: result.model,
        durationSeconds: voice.durationSeconds,
      },
    };
  }

  // The reason is logged in full and never sent: it can name the configured
  // URL, and the operator reads the log while the user reads the reply.
  console.warn(
    `[turn ${turnTag}] transcription failed (${result.provider}/${result.failure}): ${result.reason}`,
  );
  return { ok: false, reply: voiceFailureReply(result.failure, result.provider) };
}

/**
 * What to say when a voice note could not be read.
 *
 * "Unavailable" is the only one that depends on which provider was in use,
 * and it is the one where saying the wrong thing wastes the user's time: the
 * fix for a model that has not finished downloading has nothing in common
 * with the fix for a server that was never started.
 */
function voiceFailureReply(
  failure: TranscriptionFailure,
  provider: TranscriptionProvider,
): string {
  if (failure === "unavailable") {
    return provider === "local"
      ? "I couldn't get my transcription model loaded - it may still be downloading, or the download didn't finish. Type it to me for now and I'll keep trying in the background."
      : "I can't listen to voice notes right now - nothing is answering where my transcriber should be. Type it to me in the meantime?";
  }
  if (failure === "empty") {
    return "That note came through silent on my end - I didn't catch anything in it.";
  }
  return "I couldn't make sense of that recording, sorry. Mind typing it instead?";
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
