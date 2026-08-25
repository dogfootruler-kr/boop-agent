/**
 * Telegram's half of inbound image ingest.
 *
 * Telegram addresses media in two steps: `getFile` exchanges a `file_id` for a
 * path, and the path is then downloaded from a token-bearing URL. Only that
 * two-step fetch lives here; the streaming size cap, the MIME check, and the
 * upload to Convex storage are identical across Gateways and live in the
 * shared helper, `server/images/ingest.ts`.
 */
import { ingestImageFromResponse, type ImageIngestResult } from "../images/ingest.js";
import { telegramFileUrl } from "./api.js";

const DOWNLOAD_TIMEOUT_MS = 10_000;

export async function ingestTelegramImage(fileId: string): Promise<ImageIngestResult> {
  let url: string;
  try {
    url = await telegramFileUrl(fileId);
  } catch (err) {
    return { ok: false, reason: `could not resolve media: ${String(err)}` };
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }
  return ingestImageFromResponse(res);
}
