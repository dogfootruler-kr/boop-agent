/**
 * Answering "will a voice note work right now?" without sending one.
 *
 * The same answer is wanted in three places - `npm run preflight`, the
 * `/health` endpoint, and the desktop status window - so it is computed once
 * here rather than three times in three shapes.
 *
 * The remote probe deliberately does not POST audio. It asks whether anything
 * is listening, because that is the failure people actually hit: a transcriber
 * that was never started. A server that answers 404 or 405 to the probe is
 * still a server, and is reported as reachable.
 */
import { localModelIsCached, localModelName } from "./local-whisper.js";
import { activeTranscriptionProvider, remoteEndpoint, type TranscriptionProvider } from "./transcribe.js";

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
  /** What to do about it, when there is something to do. */
  readonly detail?: string;
}

let cached: { at: number; status: TranscriberStatus } | null = null;

/** The transcriber's status, re-probing at most every `PROBE_CACHE_MS`. */
export async function checkTranscriber(): Promise<TranscriberStatus> {
  const now = Date.now();
  if (cached && now - cached.at < PROBE_CACHE_MS) return cached.status;
  const status = await probe();
  cached = { at: now, status };
  return status;
}

/** Drop the cached probe, so the next check really probes. */
export function forgetTranscriberProbe(): void {
  cached = null;
}

async function probe(): Promise<TranscriberStatus> {
  if (activeTranscriptionProvider() === "local") {
    const model = localModelName();
    return localModelIsCached()
      ? { provider: "local", description: `${model} (in-process)`, state: "ready" }
      : {
          provider: "local",
          description: `${model} (in-process)`,
          state: "will-download",
          detail: "the model downloads on the first voice note - `npm run setup` can pre-fetch it",
        };
  }

  const endpoint = remoteEndpoint();
  // Unreachable: `activeTranscriptionProvider` said remote, so a URL is set.
  if (!endpoint) return { provider: "local", description: "unknown", state: "unreachable" };

  const description = `${endpoint.model} at ${endpoint.url}`;
  try {
    // The origin, not the transcription path: a GET to the endpoint itself is
    // a 405 on a well-behaved server and a 500 on a careless one, and neither
    // says anything about whether it is up.
    const origin = new URL(endpoint.url).origin;
    await fetch(origin, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { provider: "remote", description, state: "ready" };
  } catch (err) {
    return {
      provider: "remote",
      description,
      state: "unreachable",
      detail: `nothing answered at ${endpoint.url} (${String(err)})`,
    };
  }
}
