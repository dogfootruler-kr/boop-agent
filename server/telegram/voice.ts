/**
 * Telegram's half of inbound voice ingest.
 *
 * The same two-step Telegram uses for every attachment: `getFile` exchanges a
 * `file_id` for a path, and the path is downloaded from a token-bearing URL.
 * Only that fetch lives here. The size cap, the MIME check, and the call to
 * the transcriber are identical across Gateways and live in the shared helper,
 * `server/audio/transcribe.ts` - the same split as `media.ts` and
 * `server/images/ingest.ts`.
 */
import { getTranscriptionSettings } from "../audio/settings.js";
import { transcribeAudioFromResponse, type TranscriptionResult } from "../audio/transcribe.js";
import { telegramFileUrl } from "./api.js";

const DOWNLOAD_TIMEOUT_MS = 20_000;

export async function transcribeTelegramVoice(
  fileId: string,
  declaredMimeType?: string,
): Promise<TranscriptionResult> {
  // Read once for the whole call so a settings change mid-download cannot
  // produce a result attributed to the provider that did not do the work.
  const settings = await getTranscriptionSettings();
  let url: string;
  try {
    url = await telegramFileUrl(fileId);
  } catch (err) {
    return {
      ok: false,
      failure: "rejected",
      reason: `could not resolve audio: ${String(err)}`,
      provider: settings.provider,
    };
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    return {
      ok: false,
      failure: "rejected",
      reason: `download failed: ${String(err)}`,
      provider: settings.provider,
    };
  }
  return transcribeAudioFromResponse(res, declaredMimeType, settings);
}
