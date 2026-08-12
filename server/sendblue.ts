import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import {
  ingestImageFromResponse,
  type ImageIngestResult,
  type IngestedImage,
} from "./images/ingest.js";
import { redactContactHandle, redactPhoneNumbers } from "./privacy.js";
import { maybeHandleScriptedDemoReply } from "./scripted-demo-replies.js";
import { verifySendblueWebhookSecret } from "./sendblue-webhook-auth.js";
import { startTypingForConversation } from "./channels/outbound.js";
import { deliverAssistantMessage } from "./channels/delivery.js";

const API_BASE = "https://api.sendblue.com/api";
const MAX_CHUNK = 2900;

export function extractSendblueMediaUrls(
  mediaUrl: unknown,
  mediaUrls: unknown,
): string[] {
  const urls = new Set<string>();
  if (Array.isArray(mediaUrls)) {
    for (const value of mediaUrls) {
      if (typeof value === "string" && value.trim()) urls.add(value.trim());
    }
  }
  if (typeof mediaUrl === "string" && mediaUrl.trim()) urls.add(mediaUrl.trim());
  return [...urls];
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function isSendblueConfigured(): boolean {
  return Boolean(process.env.SENDBLUE_API_KEY && process.env.SENDBLUE_API_SECRET);
}

function headers(): Record<string, string> | null {
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": apiSecret,
  };
}

function normalizeE164(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const trimmed = n.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  // Bare US-length numbers get a +1. Longer/shorter just get a leading +.
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

// Outbound formatting for the `sms` channel: iMessage renders no markdown, and
// the gateway wants short parts. This is the `formatOutbound` half of the
// channel adapter in `server/channels/sms.ts`.
export function formatForImessage(text: string): string[] {
  return chunk(stripMarkdown(text));
}

// Deliver one already-formatted part. Phone-number redaction is NOT done here:
// it runs once in the shared outbound path, above per-channel formatting, so
// that no channel adapter can skip it.
export async function sendSendbluePart(toNumber: string, part: string): Promise<void> {
  const h = headers();
  if (!h) {
    console.warn("[sendblue] missing credentials — not sending");
    return;
  }
  const from = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!from) {
    console.error(
      `[sendblue] SENDBLUE_FROM_NUMBER is not set. Run \`npm run sendblue:sync\` (pulls it from \`sendblue lines\`) or paste your provisioned number into .env.local, then restart \`npm run dev\`.`,
    );
    return;
  }
  const res = await fetch(`${API_BASE}/send-message`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ number: toNumber, content: part, from_number: from }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[sendblue] send failed ${res.status}: ${redactPhoneNumbers(body).slice(0, 500)}`,
    );
    if (body.includes("missing required parameter") && body.includes("from_number")) {
      console.error(
        `[sendblue] → Set SENDBLUE_FROM_NUMBER in .env.local to your Sendblue-provisioned number and restart the server.`,
      );
    } else if (body.includes("Cannot send messages to self")) {
      console.error(
        `[sendblue] → SENDBLUE_FROM_NUMBER is your personal cell. It must be the Sendblue-provisioned number (the one people text TO).`,
      );
    } else if (body.includes("This phone number is not defined")) {
      console.error(
        `[sendblue] → Sendblue doesn't recognize from_number=${redactContactHandle(from)}. Run \`npm run sendblue:sync\` to pull the correct one from \`sendblue lines\`, then restart the server.`,
      );
    }
  } else {
    console.log(`[sendblue] → sent ${part.length} chars to ${redactContactHandle(toNumber)}`);
  }
}

export async function sendTypingIndicator(toNumber: string): Promise<void> {
  const h = headers();
  if (!h) return;
  const from = process.env.SENDBLUE_FROM_NUMBER;
  try {
    await fetch(`${API_BASE}/send-typing-indicator`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, from_number: from }),
    });
  } catch {
    /* non-fatal */
  }
}

export function startTypingLoop(toNumber: string): () => void {
  sendTypingIndicator(toNumber);
  const timer = setInterval(() => sendTypingIndicator(toNumber), 5000);
  return () => clearInterval(timer);
}

// Sendblue's half of media ingest: fetch the CDN URL, no authentication
// involved. The streaming size cap, the MIME check, and the Convex storage
// upload are identical to WhatsApp's `ingestWhatsappImage` and live in the
// shared helper, `server/images/ingest.ts`.
export async function ingestSendblueImage(url: string): Promise<ImageIngestResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }
  return ingestImageFromResponse(res);
}

export function createSendblueRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    if (!verifySendblueWebhookSecret(req.get("sb-signing-secret"))) {
      res.status(401).json({ error: "invalid webhook signature" });
      return;
    }

    const { content, from_number, is_outbound, message_handle, media_url, media_urls } =
      req.body ?? {};
    const rawUrls = extractSendblueMediaUrls(media_url, media_urls);
    if (is_outbound || !from_number || (!content && rawUrls.length === 0)) {
      res.json({ ok: true, skipped: true });
      return;
    }

    if (message_handle) {
      const { claimed } = await convex.mutation(api.channelDedup.claim, {
        channel: "sms",
        externalMessageId: message_handle,
      });
      if (!claimed) {
        res.json({ ok: true, deduped: true });
        return;
      }
    }

    const ingestResults = await Promise.all(rawUrls.map(ingestSendblueImage));
    const ingested: IngestedImage[] = [];
    const ingestErrors: string[] = [];
    for (const r of ingestResults) {
      if (r.ok) ingested.push(r.image);
      else ingestErrors.push(r.reason);
    }

    const conversationId = `sms:${from_number}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const textForLog = typeof content === "string" ? content : "";
    const safeTextForLog = redactPhoneNumbers(textForLog);
    const preview = safeTextForLog.length > 100 ? safeTextForLog.slice(0, 100) + "…" : safeTextForLog;
    console.log(`[turn ${turnTag}] ← ${redactContactHandle(from_number)}: ${JSON.stringify(preview)}`);
    const start = Date.now();

    broadcast("message_in", { conversationId, content, from_number, handle: message_handle });
    res.json({ ok: true });

    if (
      await maybeHandleScriptedDemoReply({
        conversationId,
        content: textForLog,
        turnTag,
      })
    ) {
      return;
    }

    const stopTyping = startTypingForConversation(conversationId);
    try {
      const reply = await handleUserMessage({
        conversationId,
        content: textForLog,
        turnTag,
        images: ingested,
        mediaError: ingestErrors.length > 0 ? ingestErrors.join("; ") : undefined,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const safeReplyPreview = redactPhoneNumbers(reply);
        const replyPreview = safeReplyPreview.length > 100 ? safeReplyPreview.slice(0, 100) + "…" : safeReplyPreview;
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
