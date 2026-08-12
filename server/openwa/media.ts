/**
 * WhatsApp's half of inbound media ingest.
 *
 * Sendblue serves media from an unauthenticated CDN URL; OpenWA does not.
 * Fetching an inbound attachment means an authenticated request back to the
 * Gateway itself, addressed by chat and message ID, the same way every other
 * Gateway call in `server/openwa/gateway.ts` is authenticated. That fetch is
 * this file's whole job. The streaming size cap, the MIME check, and the
 * upload to Convex storage are identical to Sendblue's half and live in the
 * shared helper, `server/images/ingest.ts`.
 */
import { ingestImageFromResponse, type ImageIngestResult } from "../images/ingest.js";
import { loadWhatsappConfig } from "./config.js";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fetch and ingest one inbound image, addressed by chat and message ID.
 *
 * Returns a drop reason rather than throwing when the Gateway is
 * unconfigured, unreachable, or refuses the request, matching the shape
 * `ingestSendblueImage` already returns for its own failure modes.
 */
export async function ingestWhatsappImage(
  chatId: string,
  messageId: string,
): Promise<ImageIngestResult> {
  const config = loadWhatsappConfig();
  if (!config) return { ok: false, reason: "gateway is not configured" };

  const url = `${config.baseUrl}/api/media?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(messageId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": config.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }
  return ingestImageFromResponse(res);
}
