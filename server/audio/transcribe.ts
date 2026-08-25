/**
 * Turning speech into the text of a turn.
 *
 * Two providers, chosen the way `server/embeddings.ts` chooses one: a
 * configured remote endpoint wins, and otherwise the work happens in-process.
 *
 *   remote  - anything speaking OpenAI's `/v1/audio/transcriptions`: a local
 *             OpenASR server running Qwen3-ASR, vLLM, Groq, OpenAI itself.
 *             Selected by setting `BOOP_TRANSCRIBE_URL`, and the only way to
 *             reach a model Transformers.js cannot run.
 *   local   - Whisper via `@huggingface/transformers`, in this process, with
 *             nothing to install. The default, so that voice notes work on a
 *             fresh checkout rather than after a setup step.
 *
 * The remote shape is OpenAI's because it is the one every transcriber
 * speaks, which is what makes "which transcriber" a URL in the environment
 * rather than a branch in here.
 *
 * Structured like `server/images/ingest.ts`: the caller owns the fetch that
 * produces the audio, because that fetch is per-Gateway (its auth, its URL
 * shape), and hands the resulting `Response` here. The size cap, the MIME
 * check, and the choice of provider are what is genuinely shared.
 */
import { canDecodeLocally, decodeToMono16k } from "./decode.js";
import { localModelName, transcribeLocally } from "./local-whisper.js";
import {
  audioFilename,
  MAX_AUDIO_BYTES,
  validateAudioHeader,
  type AudioMediaType,
} from "./mime.js";

/** The model name sent to a remote endpoint, when none is configured. */
const DEFAULT_REMOTE_MODEL = "qwen3-asr-0.6b";

/**
 * Generous, because a local model transcribing ten minutes of audio on a
 * laptop takes what it takes, and the user is already watching a typing
 * indicator.
 */
const TRANSCRIBE_TIMEOUT_MS = 180_000;

export type TranscriptionProvider = "remote" | "local";

export interface RemoteEndpoint {
  readonly url: string;
  readonly model: string;
  readonly apiKey: string | undefined;
}

/**
 * Why a voice note did not become text.
 *
 * Separated from the message because the caller answers a user with it, and
 * "the transcriber is not running" wants a different reply from "I heard
 * silence".
 */
export type TranscriptionFailure =
  /** The provider could not be used at all: nothing listening, or a model that would not load. */
  | "unavailable"
  /** The provider was reached, and could not use this audio. */
  | "rejected"
  /** The provider answered with no words in it. */
  | "empty";

export type TranscriptionResult =
  | { ok: true; text: string; provider: TranscriptionProvider }
  | { ok: false; failure: TranscriptionFailure; reason: string; provider: TranscriptionProvider };

/**
 * Which provider a transcription would use right now.
 *
 * A configured URL always wins. Someone who set one meant it, and silently
 * falling back to the in-process model would hide the fact that their
 * transcriber is down behind quietly different results.
 */
export function activeTranscriptionProvider(): TranscriptionProvider {
  return remoteEndpoint() ? "remote" : "local";
}

/** The configured remote endpoint, or null when there is none. */
export function remoteEndpoint(): RemoteEndpoint | null {
  const url = process.env.BOOP_TRANSCRIBE_URL?.trim();
  if (!url) return null;
  // OPENAI_API_KEY is honoured only when the endpoint is actually OpenAI's.
  // A key set for embeddings must not be posted to whatever host someone put
  // in BOOP_TRANSCRIBE_URL.
  const apiKey =
    process.env.BOOP_TRANSCRIBE_API_KEY?.trim() ||
    (isOpenAiHost(url) ? process.env.OPENAI_API_KEY?.trim() : undefined) ||
    undefined;
  return {
    url,
    model: process.env.BOOP_TRANSCRIBE_MODEL?.trim() || DEFAULT_REMOTE_MODEL,
    apiKey,
  };
}

/** One line naming the active provider, for logs and status surfaces. */
export function describeTranscriber(): string {
  const remote = remoteEndpoint();
  return remote ? `${remote.model} at ${remote.url}` : `${localModelName()} (in-process)`;
}

/**
 * Validate, cap, and transcribe an already-fetched audio response.
 *
 * `declaredMimeType` is the type the Gateway put on the message envelope, used
 * when the download itself does not say - see `AudioHeader.declaredType`.
 */
export async function transcribeAudioFromResponse(
  res: Response,
  declaredMimeType?: string,
): Promise<TranscriptionResult> {
  const provider = activeTranscriptionProvider();
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    return fail(provider, "rejected", `download failed: HTTP ${res.status}`);
  }
  const lenHeader = res.headers.get("content-length");
  const check = validateAudioHeader({
    contentType: res.headers.get("content-type") ?? undefined,
    declaredType: declaredMimeType,
    contentLength: lenHeader ? Number(lenHeader) : undefined,
  });
  if (!check.ok) {
    res.body?.cancel().catch(() => undefined);
    return fail(provider, "rejected", check.reason);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await readCapped(res);
  } catch (err) {
    return fail(provider, "rejected", `download failed: ${String(err)}`);
  }
  if (bytes.byteLength === 0) return fail(provider, "empty", "the audio was empty");

  return transcribeAudioBytes(bytes, check.mediaType);
}

/** Transcribe already-downloaded audio with whichever provider is active. */
export async function transcribeAudioBytes(
  bytes: ArrayBuffer,
  mediaType: AudioMediaType,
): Promise<TranscriptionResult> {
  const remote = remoteEndpoint();
  return remote
    ? transcribeRemotely(bytes, mediaType, remote)
    : transcribeWithLocalModel(bytes, mediaType);
}

async function transcribeWithLocalModel(
  bytes: ArrayBuffer,
  mediaType: AudioMediaType,
): Promise<TranscriptionResult> {
  if (!canDecodeLocally(mediaType)) {
    // Worth being specific about: it is not a broken file, it is a container
    // the in-process path has no decoder for, and the fix is a remote
    // transcriber rather than a different recording.
    return fail(
      "local",
      "rejected",
      `${mediaType} needs a remote transcriber - the in-process one reads Ogg/Opus and WAV only`,
    );
  }

  const decoded = await decodeToMono16k(bytes, mediaType);
  if (!decoded.ok) return fail("local", "rejected", decoded.reason);

  let text: string;
  try {
    text = await transcribeLocally(decoded.samples);
  } catch (err) {
    // Loading the model is the part that fails, and it fails by not being
    // downloadable. That is the same event as "no transcriber answered", so
    // it gets the same classification.
    return fail("local", "unavailable", `local model failed: ${String(err)}`);
  }

  if (!text) return fail("local", "empty", "the transcript was empty");
  return { ok: true, text, provider: "local" };
}

async function transcribeRemotely(
  bytes: ArrayBuffer,
  mediaType: AudioMediaType,
  endpoint: RemoteEndpoint,
): Promise<TranscriptionResult> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mediaType }), audioFilename(mediaType));
  form.append("model", endpoint.model);
  form.append("response_format", "json");

  let res: Response;
  try {
    res = await fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (err) {
    // A transport failure here is not "the audio was bad", it is "there is no
    // transcriber", and the two get different answers. The URL is included
    // because the fix is nearly always to start the server at it, and it
    // carries no credential - the key travels in a header.
    return fail("remote", "unavailable", `no transcriber answered at ${endpoint.url}: ${String(err)}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // A 404 at a URL that did answer means something is listening but it is
    // not a transcription API - a wrong path, or a server without the model.
    // That is a configuration problem, so it is reported as one.
    const failure: TranscriptionFailure = res.status === 404 ? "unavailable" : "rejected";
    return fail(
      "remote",
      failure,
      `transcriber returned HTTP ${res.status}${detail ? `: ${trim(detail)}` : ""}`,
    );
  }

  try {
    const body = (await res.json()) as { text?: unknown };
    if (typeof body.text !== "string") {
      return fail("remote", "rejected", "transcriber returned no text field");
    }
    const text = body.text.trim();
    if (!text) return fail("remote", "empty", "the transcript was empty");
    return { ok: true, text, provider: "remote" };
  } catch (err) {
    return fail("remote", "rejected", `transcriber returned a non-JSON body: ${String(err)}`);
  }
}

/**
 * Read the body, aborting rather than buffering once it passes the cap.
 *
 * `content-length` is checked first where present, but it is often absent on
 * a CDN response, so the running total is what actually enforces the limit.
 */
async function readCapped(res: Response): Promise<ArrayBuffer> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUDIO_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`audio too large: >${MAX_AUDIO_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const out = new ArrayBuffer(total);
  const view = new Uint8Array(out);
  let offset = 0;
  for (const c of chunks) {
    view.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function isOpenAiHost(url: string): boolean {
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/** Keep an upstream error body short enough to log on one line. */
function trim(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function fail(
  provider: TranscriptionProvider,
  failure: TranscriptionFailure,
  reason: string,
): TranscriptionResult {
  return { ok: false, failure, reason, provider };
}
