/**
 * What counts as audio Boop will try to transcribe.
 *
 * Deliberately a mirror of `server/images/mime.ts` rather than a merge with
 * it: the two lists have nothing in common, the two size caps are set by
 * different limits (Convex storage for images, the transcriber's request cap
 * for audio), and folding them together would produce one function whose
 * answer depends on which caller asked.
 */

/** 25 MB, the request cap every OpenAI-compatible transcription API shares. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * How much speech Boop will sit through.
 *
 * A Telegram voice note is Opus at roughly 2 KB/s, so the byte cap alone
 * would admit something like three hours of audio - long enough that the
 * transcribe call looks hung rather than slow. Duration is on the message
 * envelope, so this is checked before anything is downloaded.
 */
export const MAX_AUDIO_SECONDS = 600;

export const ALLOWED_AUDIO_MIME_LIST = [
  // What Telegram's own voice notes arrive as.
  "audio/ogg",
  "audio/opus",
  // What a voice memo forwarded from another app tends to arrive as.
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
] as const;

export type AudioMediaType = (typeof ALLOWED_AUDIO_MIME_LIST)[number];

export const ALLOWED_AUDIO_MIME: ReadonlySet<string> = new Set(ALLOWED_AUDIO_MIME_LIST);

export type AudioHeaderCheck =
  | { ok: true; mediaType: AudioMediaType }
  | { ok: false; reason: string };

export interface AudioHeader {
  /** The `content-type` on the download response. Often absent or generic. */
  contentType: string | undefined;
  /**
   * The `mime_type` the Gateway declared on the message envelope.
   *
   * Used when the download's own `content-type` is missing or generic.
   * Telegram serves `.oga` from its file CDN as `application/octet-stream`
   * often enough that trusting the response header alone would reject
   * ordinary voice notes, and the envelope's declaration is the same
   * authenticated source the `file_id` came from.
   */
  declaredType: string | undefined;
  contentLength: number | undefined;
}

function normalizeContentType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const semi = raw.indexOf(";");
  const trimmed = (semi >= 0 ? raw.slice(0, semi) : raw).trim().toLowerCase();
  if (!trimmed) return undefined;
  // Not a lie about the content, just an absence of one: fall through to the
  // envelope's declaration rather than rejecting.
  if (trimmed === "application/octet-stream" || trimmed === "binary/octet-stream") return undefined;
  return trimmed;
}

export function validateAudioHeader(header: AudioHeader): AudioHeaderCheck {
  const mime = normalizeContentType(header.contentType) ?? normalizeContentType(header.declaredType);
  if (!mime) return { ok: false, reason: "missing content-type" };
  if (!ALLOWED_AUDIO_MIME.has(mime)) {
    return { ok: false, reason: `disallowed mime type: ${mime}` };
  }
  if (typeof header.contentLength === "number" && header.contentLength > MAX_AUDIO_BYTES) {
    return { ok: false, reason: `audio too large: ${header.contentLength} bytes` };
  }
  return { ok: true, mediaType: mime as AudioMediaType };
}

/**
 * A filename to put on the multipart part.
 *
 * The transcriber hands non-WAV input to ffmpeg, which picks a demuxer partly
 * from the extension, so a part named `blob` is a real failure mode rather
 * than a cosmetic one.
 */
export function audioFilename(mediaType: AudioMediaType): string {
  return `voice.${AUDIO_EXTENSIONS[mediaType]}`;
}

const AUDIO_EXTENSIONS: Record<AudioMediaType, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
};
