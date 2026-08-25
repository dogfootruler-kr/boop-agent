/**
 * Answering "will a voice note work right now?" without sending one.
 *
 * The same answer is wanted in four places - `npm run preflight`, the
 * `/health` endpoint, the desktop status window, and the dashboard's settings
 * section - so it is computed once here rather than four times in four shapes.
 *
 * The remote probe deliberately does not POST audio. It asks whether anything
 * is listening, because that is the failure people actually hit: a transcriber
 * that was never started. A server that answers 404 or 405 to the probe is
 * still a server, and is reported as reachable.
 */
import { localModelIsCached, localTranscriberIsWarm } from "./local-whisper.js";
import {
  describeTranscriber,
  getTranscriptionSettings,
  type TranscriptionProvider,
  type TranscriptionSettings,
} from "./settings.js";

const PROBE_TIMEOUT_MS = 2_000;
/** How long a probe result stands. `/health` is polled; the transcriber is not. */
const PROBE_CACHE_MS = 30_000;

export type TranscriberState =
  /** Voice notes will work now. */
  | "ready"
  /** Voice notes will work, but the first one pays for a model download. */
  | "will-download"
  /** Voice notes will fail: nothing is listening where the endpoint points. */
  | "unreachable";

export interface TranscriberStatus {
  readonly provider: TranscriptionProvider;
  /** The model, and where it runs. Safe to show: it carries no credential. */
  readonly description: string;
  readonly state: TranscriberState;
  /** Whether the model is loaded in memory, so the next note pays nothing. */
  readonly warm: boolean;
  /** What to do about it, when there is something to do. */
  readonly detail?: string;
}

let cached: { at: number; status: TranscriberStatus } | null = null;

/** The transcriber's status, re-probing at most every `PROBE_CACHE_MS`. */
export async function checkTranscriber(
  settings?: TranscriptionSettings,
): Promise<TranscriberStatus> {
  const now = Date.now();
  // A caller that passed settings is asking about those settings, which is
  // exactly the case where a cached answer would be about the old ones.
  if (!settings && cached && now - cached.at < PROBE_CACHE_MS) return cached.status;
  const status = await probe(settings ?? (await getTranscriptionSettings()));
  if (!settings) cached = { at: now, status };
  return status;
}

/** Drop the cached probe, so the next check really probes. */
export function forgetTranscriberProbe(): void {
  cached = null;
}

async function probe(settings: TranscriptionSettings): Promise<TranscriberStatus> {
  const description = describeTranscriber(settings);

  if (settings.provider === "local") {
    const warm = localTranscriberIsWarm(settings.localModel);
    return localModelIsCached(settings.localModel)
      ? { provider: "local", description, state: "ready", warm }
      : {
          provider: "local",
          description,
          state: "will-download",
          warm,
          detail: "the model downloads on the first voice note",
        };
  }

  try {
    // The origin, not the transcription path: a GET to the endpoint itself is
    // a 405 on a well-behaved server and a 500 on a careless one, and neither
    // says anything about whether it is up.
    const origin = new URL(settings.url).origin;
    await fetch(origin, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { provider: "remote", description, state: "ready", warm: true };
  } catch (err) {
    return {
      provider: "remote",
      description,
      state: "unreachable",
      warm: false,
      detail: `nothing answered at ${settings.url} (${String(err)})`,
    };
  }
}
