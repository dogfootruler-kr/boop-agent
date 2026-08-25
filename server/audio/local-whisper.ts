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
 * exists. Qwen3-ASR is still reachable, through a remote transcriber; it just
 * cannot be the zero-install default.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { TARGET_SAMPLE_RATE } from "./decode.js";

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

/**
 * Loaded pipelines, keyed by model.
 *
 * Keyed rather than a single slot because the model is a setting now: someone
 * switching from base to small in the dashboard must get the model they
 * picked, not the one that happened to load first. Switching back is then
 * free, which matters when the alternative is a second download.
 */
const loaded = new Map<string, AutomaticSpeechRecognitionPipeline>();
const loading = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

/**
 * Whether a model is on disk, and so usable without a download.
 *
 * Checked by looking for the weights rather than the folder: an interrupted
 * download leaves the config files behind, and reporting that as ready would
 * promise a first voice note that then stalls fetching the rest.
 */
export function localModelIsCached(model: string): boolean {
  return existsSync(resolve(LOCAL_CACHE_DIR, model, "onnx"));
}

/** Whether a model is already in memory, so the next note pays nothing. */
export function localTranscriberIsWarm(model: string): boolean {
  return loaded.has(model);
}

/**
 * Load a pipeline once, and let concurrent callers share one load.
 *
 * A rejected load clears the slot so the next call retries: the first thing
 * that can fail here is a multi-hundred-megabyte download over someone's
 * network, and replaying a cached rejection forever would turn one dropped
 * connection into a permanently broken feature.
 */
export async function getLocalTranscriber(
  model: string,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const ready = loaded.get(model);
  if (ready) return ready;
  const inFlight = loading.get(model);
  if (inFlight) return inFlight;

  const attempt = (async () => {
    const { env, pipeline } = await import("@huggingface/transformers");
    await mkdir(LOCAL_CACHE_DIR, { recursive: true });
    env.cacheDir = LOCAL_CACHE_DIR;
    console.log(`[transcribe] loading local model ${model} (downloads on first run)…`);
    const start = Date.now();
    const asr = await pipeline("automatic-speech-recognition", model, { dtype: "q8" });
    console.log(`[transcribe] local model ready in ${Date.now() - start}ms`);
    loaded.set(model, asr);
    return asr;
  })();

  loading.set(model, attempt);
  attempt
    .catch(() => undefined)
    .finally(() => {
      if (loading.get(model) === attempt) loading.delete(model);
    });
  return attempt;
}

/**
 * Load a model in the background so the first voice note does not pay for it.
 * Safe to call at startup - failures are logged, not thrown.
 */
export function preloadLocalTranscriber(model: string): void {
  getLocalTranscriber(model).catch((err) => {
    console.warn("[transcribe] local model preload failed:", err);
  });
}

/** Transcribe mono PCM at `TARGET_SAMPLE_RATE`. */
export async function transcribeLocally(
  samples: Float32Array,
  options: { model: string; language: string },
): Promise<string> {
  const asr = await getLocalTranscriber(options.model);
  const output = await asr(samples, {
    chunk_length_s: CHUNK_LENGTH_S,
    stride_length_s: STRIDE_LENGTH_S,
    // Omitted rather than passed empty: Whisper's own default is English, and
    // an empty string is not a language it knows.
    ...(options.language ? { language: options.language, task: "transcribe" } : {}),
  });
  const text = Array.isArray(output)
    ? output.map((part) => part.text).join(" ")
    : (output.text ?? "");
  return text.trim();
}

export { TARGET_SAMPLE_RATE };
