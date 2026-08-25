/**
 * Transcription that runs inside Boop, with nothing to install.
 *
 * Modelled directly on the local branch of `server/embeddings.ts`, and for the
 * same reason: a feature nobody can use until they install a service is a
 * feature most people never turn on. The model is fetched from Hugging Face on
 * first use and cached in Boop's own data folder, so the cost is one download
 * rather than a setup step, and audio never leaves the machine.
 *
 * Whisper rather than Qwen3-ASR, which is the better model: Transformers.js
 * 4.2.0 implements no `qwen3_asr` architecture - `whisper` is the only ASR
 * family in its mapping - and no Transformers.js-ready ONNX export of it
 * exists. Qwen3-ASR is still reachable, through a transcriber at
 * `BOOP_TRANSCRIBE_URL`; it just cannot be the zero-install default.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { TARGET_SAMPLE_RATE } from "./decode.js";

/**
 * Small and quantized by default: a voice note is seconds of speech and the
 * user is waiting on it, so first-run download size and per-turn latency
 * matter more here than the last few points of accuracy. Override with
 * `BOOP_TRANSCRIBE_LOCAL_MODEL` - `onnx-community/whisper-small` is the usual
 * step up, and is noticeably better outside English.
 */
const DEFAULT_LOCAL_MODEL = "onnx-community/whisper-base";

/** Shared with the embedding model, which already caches here. */
const LOCAL_CACHE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "huggingface-cache",
);

/**
 * Whisper reads 30 seconds at a time. Longer audio is chunked, with an overlap
 * so a word straddling a boundary is not lost from both sides.
 */
const CHUNK_LENGTH_S = 30;
const STRIDE_LENGTH_S = 5;

export function localModelName(): string {
  return process.env.BOOP_TRANSCRIBE_LOCAL_MODEL?.trim() || DEFAULT_LOCAL_MODEL;
}

/**
 * The language to decode as, or undefined to let Whisper detect it.
 *
 * Detection is good on a clear sentence and unreliable on a two-word note, so
 * someone who always speaks the same language is better off naming it.
 */
export function localLanguage(): string | undefined {
  return process.env.BOOP_TRANSCRIBE_LANGUAGE?.trim() || undefined;
}

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

/**
 * Load the pipeline once, and let concurrent callers share one load.
 *
 * A rejected load clears the slot so the next call retries: the first thing
 * that can fail here is a multi-hundred-megabyte download over someone's
 * network, and replaying a cached rejection forever would turn one dropped
 * connection into a permanently broken feature.
 */
export async function getLocalTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriber) return transcriber;
  if (loading) return loading;

  const attempt = (async () => {
    const { env, pipeline } = await import("@huggingface/transformers");
    await mkdir(LOCAL_CACHE_DIR, { recursive: true });
    env.cacheDir = LOCAL_CACHE_DIR;
    const model = localModelName();
    console.log(`[transcribe] loading local model ${model} (downloads on first run)…`);
    const start = Date.now();
    const asr = await pipeline("automatic-speech-recognition", model, { dtype: "q8" });
    console.log(`[transcribe] local model ready in ${Date.now() - start}ms`);
    transcriber = asr;
    return asr;
  })();

  loading = attempt;
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return loading;
}

/** Whether the model is already loaded, so a caller can say "this will take a moment". */
export function localTranscriberIsWarm(): boolean {
  return transcriber !== null;
}

/**
 * Whether the model is on disk, and so usable without a download.
 *
 * Checked by looking for the weights rather than the folder: an interrupted
 * download leaves the config files behind, and reporting that as ready would
 * promise a first voice note that then stalls fetching the rest.
 */
export function localModelIsCached(): boolean {
  return existsSync(resolve(LOCAL_CACHE_DIR, localModelName(), "onnx"));
}

/**
 * Load the model in the background so the first voice note does not pay for
 * it. Safe to call at startup - failures are logged, not thrown.
 */
export function preloadLocalTranscriber(): void {
  getLocalTranscriber().catch((err) => {
    console.warn("[transcribe] local model preload failed:", err);
  });
}

/** Transcribe mono PCM at `TARGET_SAMPLE_RATE`. */
export async function transcribeLocally(samples: Float32Array): Promise<string> {
  const asr = await getLocalTranscriber();
  const language = localLanguage();
  const output = await asr(samples, {
    chunk_length_s: CHUNK_LENGTH_S,
    stride_length_s: STRIDE_LENGTH_S,
    ...(language ? { language, task: "transcribe" } : {}),
  });
  const text = Array.isArray(output)
    ? output.map((part) => part.text).join(" ")
    : (output.text ?? "");
  return text.trim();
}

/** The sample rate `transcribeLocally` expects, re-exported for callers. */
export { TARGET_SAMPLE_RATE };
