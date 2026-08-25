/**
 * Where the transcription settings live.
 *
 * Convex first, environment second, exactly like `getBrowserSettings` and
 * `getAppleSettings` in `server/runtime-config.ts`: the dashboard writes to
 * Convex so a change takes effect without editing a file or restarting, and
 * `.env.local` remains the way to set it up before there is a dashboard to
 * click.
 *
 * The API key is the one thing deliberately NOT stored here. It is a
 * credential, `.env.local` is already where this project keeps credentials,
 * and a settings row would put it somewhere it can be read back out and
 * rendered into a web page. The dashboard is told only whether one is set.
 */
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";

export const TRANSCRIPTION_URL_KEY = "transcription_url";
export const TRANSCRIPTION_MODEL_KEY = "transcription_model";
export const TRANSCRIPTION_LOCAL_MODEL_KEY = "transcription_local_model";
export const TRANSCRIPTION_LANGUAGE_KEY = "transcription_language";

/**
 * Where an unconfigured Boop transcribes: in this process, with a model small
 * enough that the first-run download is not a decision anyone has to make.
 */
export const DEFAULT_LOCAL_MODEL = "onnx-community/whisper-base";
/** The model name sent to a remote endpoint when none is configured. */
export const DEFAULT_REMOTE_MODEL = "qwen3-asr-0.6b";

/** Local models the dashboard offers. Any other value can still be set by env. */
export const LOCAL_MODEL_CHOICES = [
  { value: "onnx-community/whisper-base", label: "whisper-base", note: "~75MB, fastest" },
  {
    value: "onnx-community/whisper-small",
    label: "whisper-small",
    note: "~250MB, better outside English",
  },
] as const;

const SETTINGS_TTL_MS = 5_000;

export type TranscriptionProvider = "remote" | "local";

export interface TranscriptionSettings {
  readonly provider: TranscriptionProvider;
  /** The remote endpoint, or "" when transcription happens in-process. */
  readonly url: string;
  /** The model name asked of a remote endpoint. */
  readonly model: string;
  /** The Hugging Face repo the in-process model comes from. */
  readonly localModel: string;
  /**
   * The language the in-process model decodes as, or "" for its default.
   *
   * Not cosmetic: Whisper does not detect the language here, so "" means every
   * note is read as English and non-English speech comes back as fluent
   * English nonsense rather than as an error.
   */
  readonly language: string;
  /** Whether BOOP_TRANSCRIBE_API_KEY (or a usable OPENAI_API_KEY) is present. */
  readonly apiKeyConfigured: boolean;
}

let cached: { at: number; value: TranscriptionSettings } | null = null;

/** Settings from the environment alone, ignoring anything stored in Convex. */
export function transcriptionSettingsFromEnv(): TranscriptionSettings {
  return build({
    url: process.env.BOOP_TRANSCRIBE_URL,
    model: process.env.BOOP_TRANSCRIBE_MODEL,
    localModel: process.env.BOOP_TRANSCRIBE_LOCAL_MODEL,
    language: process.env.BOOP_TRANSCRIBE_LANGUAGE,
  });
}

/**
 * The settings in force, with anything stored in Convex winning over the
 * environment.
 *
 * Falls back to the environment when Convex cannot be reached, so a
 * transcription does not fail just because the database is briefly away.
 */
export async function getTranscriptionSettings(): Promise<TranscriptionSettings> {
  if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached.value;

  const [url, model, localModel, language] = await Promise.all([
    getSetting(TRANSCRIPTION_URL_KEY),
    getSetting(TRANSCRIPTION_MODEL_KEY),
    getSetting(TRANSCRIPTION_LOCAL_MODEL_KEY),
    getSetting(TRANSCRIPTION_LANGUAGE_KEY),
  ]);

  const value = build({
    // `?? undefined` rather than `||`: a stored empty string is a real answer
    // ("use the in-process model"), and must not fall through to an env var
    // the user has just chosen to override.
    url: url ?? process.env.BOOP_TRANSCRIBE_URL,
    model: model ?? process.env.BOOP_TRANSCRIBE_MODEL,
    localModel: localModel ?? process.env.BOOP_TRANSCRIBE_LOCAL_MODEL,
    language: language ?? process.env.BOOP_TRANSCRIBE_LANGUAGE,
  });
  cached = { at: Date.now(), value };
  return value;
}

export interface TranscriptionSettingsPatch {
  readonly url?: string;
  readonly model?: string;
  readonly localModel?: string;
  readonly language?: string;
}

/** Persist a change and return the settings that are now in force. */
export async function saveTranscriptionSettings(
  patch: TranscriptionSettingsPatch,
): Promise<TranscriptionSettings> {
  const writes: Array<Promise<unknown>> = [];
  const put = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    writes.push(convex.mutation(api.settings.set, { key, value: value.trim() }));
  };
  put(TRANSCRIPTION_URL_KEY, patch.url);
  put(TRANSCRIPTION_MODEL_KEY, patch.model);
  put(TRANSCRIPTION_LOCAL_MODEL_KEY, patch.localModel);
  put(TRANSCRIPTION_LANGUAGE_KEY, patch.language?.toLowerCase());
  await Promise.all(writes);
  clearTranscriptionSettingsCache();
  return getTranscriptionSettings();
}

export function clearTranscriptionSettingsCache(): void {
  cached = null;
}

/** One line naming the active provider, for logs and status surfaces. */
export function describeTranscriber(settings: TranscriptionSettings): string {
  return settings.provider === "remote"
    ? `${settings.model} at ${settings.url}`
    : `${settings.localModel} (in-process)`;
}

/**
 * The bearer token for a remote endpoint, or undefined.
 *
 * OPENAI_API_KEY is honoured only when the endpoint is actually OpenAI's. A
 * key set for embeddings must not be posted to whatever host someone put in
 * the URL field.
 */
export function transcriptionApiKey(url: string): string | undefined {
  const explicit = process.env.BOOP_TRANSCRIBE_API_KEY?.trim();
  if (explicit) return explicit;
  return isOpenAiHost(url) ? process.env.OPENAI_API_KEY?.trim() || undefined : undefined;
}

function build(raw: {
  url?: string;
  model?: string;
  localModel?: string;
  language?: string;
}): TranscriptionSettings {
  const url = raw.url?.trim() ?? "";
  return {
    provider: url ? "remote" : "local",
    url,
    model: raw.model?.trim() || DEFAULT_REMOTE_MODEL,
    localModel: raw.localModel?.trim() || DEFAULT_LOCAL_MODEL,
    language: raw.language?.trim().toLowerCase() ?? "",
    apiKeyConfigured: Boolean(transcriptionApiKey(url)),
  };
}

function isOpenAiHost(url: string): boolean {
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

async function getSetting(key: string): Promise<string | null> {
  try {
    return await convex.query(api.settings.get, { key });
  } catch (err) {
    console.warn(`[transcribe] settings:get ${key} failed`, err);
    return null;
  }
}
