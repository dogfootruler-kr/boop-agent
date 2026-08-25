import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  audioFilename,
  MAX_AUDIO_BYTES,
  validateAudioHeader,
} from "../server/audio/mime.js";
import { transcriptionSettingsFromEnv } from "../server/audio/settings.js";
import { transcribeAudioFromResponse } from "../server/audio/transcribe.js";

const TRANSCRIBE_ENV = [
  "BOOP_TRANSCRIBE_URL",
  "BOOP_TRANSCRIBE_MODEL",
  "BOOP_TRANSCRIBE_API_KEY",
  "OPENAI_API_KEY",
] as const;
const originalEnv = new Map(TRANSCRIBE_ENV.map((key) => [key, process.env[key]]));

/** A download response carrying `body` as the audio. */
function audioResponse(
  body: string | Uint8Array = "ogg-bytes",
  headers: Record<string, string> = { "content-type": "audio/ogg" },
): Response {
  return new Response(typeof body === "string" ? new TextEncoder().encode(body) : body, {
    status: 200,
    headers,
  });
}

/** Stub `fetch` so no test reaches a real transcriber. */
function stubTranscriber(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) =>
      Promise.resolve(impl(String(input), (init ?? {}) as RequestInit)),
    );
}

const REMOTE_URL = "http://127.0.0.1:8080/v1/audio/transcriptions";

beforeEach(() => {
  for (const key of TRANSCRIBE_ENV) delete process.env[key];
});

/** Select the remote provider, which is what the wire-level tests exercise. */
function useRemote(url = REMOTE_URL): void {
  process.env.BOOP_TRANSCRIBE_URL = url;
}

/**
 * Settings built from the environment alone.
 *
 * Passed explicitly so no test reaches for Convex: the production path reads
 * stored settings first, and a unit test that needed a database to check MIME
 * handling would be testing the wrong thing.
 */
function envSettings() {
  return transcriptionSettingsFromEnv();
}

/** `transcribeAudioFromResponse`, pinned to the environment's settings. */
function transcribe(res: Response, declaredMimeType?: string) {
  return transcribeAudioFromResponse(res, declaredMimeType, envSettings());
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("validateAudioHeader", () => {
  it("accepts the Ogg/Opus a Telegram voice note arrives as", () => {
    expect(validateAudioHeader({ contentType: "audio/ogg", declaredType: undefined, contentLength: 9001 })).toEqual({
      ok: true,
      mediaType: "audio/ogg",
    });
  });

  it("ignores a charset parameter on the content type", () => {
    expect(
      validateAudioHeader({ contentType: "audio/mpeg; charset=binary", declaredType: undefined, contentLength: 1 }),
    ).toEqual({ ok: true, mediaType: "audio/mpeg" });
  });

  it("falls back to the envelope's declared type when the download says octet-stream", () => {
    // Telegram's file CDN serves .oga generically often enough that trusting
    // the response header alone would reject ordinary voice notes.
    expect(
      validateAudioHeader({
        contentType: "application/octet-stream",
        declaredType: "audio/ogg",
        contentLength: 1,
      }),
    ).toEqual({ ok: true, mediaType: "audio/ogg" });
  });

  it("prefers the download's own content type over the declared one", () => {
    expect(
      validateAudioHeader({ contentType: "audio/wav", declaredType: "audio/ogg", contentLength: 1 }),
    ).toEqual({ ok: true, mediaType: "audio/wav" });
  });

  it("rejects a type that is not audio at all", () => {
    expect(
      validateAudioHeader({ contentType: "video/mp4", declaredType: undefined, contentLength: 1 }),
    ).toMatchObject({ ok: false });
  });

  it("rejects when neither source says anything", () => {
    expect(
      validateAudioHeader({
        contentType: "application/octet-stream",
        declaredType: undefined,
        contentLength: 1,
      }),
    ).toMatchObject({ ok: false, reason: "missing content-type" });
  });

  it("rejects a declared length over the cap", () => {
    expect(
      validateAudioHeader({
        contentType: "audio/ogg",
        declaredType: undefined,
        contentLength: MAX_AUDIO_BYTES + 1,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("audioFilename", () => {
  it("names the multipart part with an extension ffmpeg can demux from", () => {
    expect(audioFilename("audio/ogg")).toBe("voice.ogg");
    expect(audioFilename("audio/x-m4a")).toBe("voice.m4a");
  });
});

describe("provider selection", () => {
  it("transcribes in-process when no endpoint is configured", () => {
    // The whole point of the default: a fresh checkout can hear a voice note
    // without anyone installing a transcriber first.
    expect(envSettings()).toMatchObject({ provider: "local", url: "" });
  });

  it("hands the work to an endpoint as soon as one is set", () => {
    useRemote();
    expect(envSettings().provider).toBe("remote");
  });

  it("does not fall back to the local model when the endpoint is unreachable", () => {
    // Falling back would hide a broken transcriber behind quietly different
    // results, which is worse than failing where the user can see it.
    useRemote("http://127.0.0.1:9/v1/audio/transcriptions");
    expect(envSettings().provider).toBe("remote");
  });

  it("defaults an endpoint's model to Qwen3-ASR", () => {
    useRemote();
    expect(envSettings()).toMatchObject({ url: REMOTE_URL, model: "qwen3-asr-0.6b" });
  });

  it("defaults the in-process model to whisper-base", () => {
    expect(envSettings().localModel).toBe("onnx-community/whisper-base");
  });

  it("normalises the language, which Whisper wants lowercased", () => {
    process.env.BOOP_TRANSCRIBE_LANGUAGE = " German ";
    expect(envSettings().language).toBe("german");
  });

  it("does not send OPENAI_API_KEY to a host that is not OpenAI", () => {
    // The key is set for embeddings; a URL pointing anywhere else must not
    // turn it into a credential handed to a third party.
    process.env.OPENAI_API_KEY = "sk-not-a-real-key";
    useRemote("https://asr.example.com/v1/audio/transcriptions");
    expect(envSettings().apiKeyConfigured).toBe(false);
  });

  it("uses OPENAI_API_KEY when the endpoint really is OpenAI's", () => {
    process.env.OPENAI_API_KEY = "sk-not-a-real-key";
    useRemote("https://api.openai.com/v1/audio/transcriptions");
    expect(envSettings().apiKeyConfigured).toBe(true);
  });

  it("never puts the key itself in the settings the dashboard is shown", () => {
    process.env.BOOP_TRANSCRIBE_API_KEY = "sk-transcribe";
    useRemote();
    expect(JSON.stringify(envSettings())).not.toContain("sk-transcribe");
  });
});

describe("the in-process provider", () => {
  it("refuses a container it has no decoder for, without loading a model", async () => {
    // mp3 needs ffmpeg, which is exactly what the in-process path exists to
    // avoid requiring. The answer must name the fix rather than look like a
    // corrupt file.
    const result = await transcribe(audioResponse("id3-bytes", { "content-type": "audio/mpeg" }));
    expect(result).toMatchObject({ ok: false, failure: "rejected", provider: "local" });
    expect((result as { reason: string }).reason).toContain("remote transcriber");
  });

  it("reports undecodable Ogg as rejected rather than crashing", async () => {
    const result = await transcribe(audioResponse("not really ogg"));
    expect(result).toMatchObject({ ok: false, failure: "rejected", provider: "local" });
  });
});

describe("transcribeAudioFromResponse (remote)", () => {
  beforeEach(() => useRemote());

  it("posts the audio as multipart and returns the transcript", async () => {
    let seen: { url: string; model: unknown; filename: string; auth: string | null } | undefined;
    stubTranscriber(async (url, init) => {
      const form = init.body as FormData;
      const file = form.get("file") as File;
      seen = {
        url,
        model: form.get("model"),
        filename: file.name,
        auth: new Headers(init.headers ?? {}).get("authorization"),
      };
      return Response.json({ text: "  buy milk on the way home  " });
    });

    const result = await transcribe(audioResponse());

    // The model comes back with the text so the message it becomes can record
    // which transcriber produced it.
    expect(result).toEqual({
      ok: true,
      text: "buy milk on the way home",
      provider: "remote",
      model: "qwen3-asr-0.6b",
    });
    expect(seen).toMatchObject({
      url: "http://127.0.0.1:8080/v1/audio/transcriptions",
      model: "qwen3-asr-0.6b",
      filename: "voice.ogg",
      // No key configured, so no header at all rather than an empty bearer.
      auth: null,
    });
  });

  it("reports an unreachable transcriber as unavailable, not as bad audio", async () => {
    stubTranscriber(() => {
      throw new TypeError("fetch failed");
    });
    const result = await transcribe(audioResponse());
    expect(result).toMatchObject({ ok: false, failure: "unavailable", provider: "remote" });
  });

  it("treats a 404 as a misconfigured endpoint rather than a refused recording", async () => {
    stubTranscriber(() => new Response("not found", { status: 404 }));
    const result = await transcribe(audioResponse());
    expect(result).toMatchObject({ ok: false, failure: "unavailable", provider: "remote" });
  });

  it("treats a 5xx from the transcriber as a rejection", async () => {
    stubTranscriber(() => new Response("model exploded", { status: 500 }));
    const result = await transcribe(audioResponse());
    expect(result).toMatchObject({ ok: false, failure: "rejected" });
  });

  it("reports a transcript with no words in it as empty", async () => {
    stubTranscriber(() => Response.json({ text: "   " }));
    const result = await transcribe(audioResponse());
    expect(result).toMatchObject({ ok: false, failure: "empty" });
  });

  it("does not call the transcriber at all when the download failed", async () => {
    const fetchSpy = stubTranscriber(() => Response.json({ text: "never" }));
    const result = await transcribe(new Response("nope", { status: 502 }));
    expect(result).toMatchObject({ ok: false, failure: "rejected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call the transcriber for a file type it cannot use", async () => {
    const fetchSpy = stubTranscriber(() => Response.json({ text: "never" }));
    const result = await transcribe(audioResponse("bytes", { "content-type": "application/pdf" }));
    expect(result).toMatchObject({ ok: false, failure: "rejected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aborts a body that runs past the cap instead of buffering it", async () => {
    // No content-length, which is the case the running total exists for.
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const fetchSpy = stubTranscriber(() => Response.json({ text: "never" }));
    const result = await transcribe(
      new Response(oversized, { status: 200, headers: { "content-type": "audio/ogg" } }),
    );
    expect(result).toMatchObject({ ok: false, failure: "rejected" });
    expect(String((result as { reason: string }).reason)).toContain("too large");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends a bearer token when one is configured", async () => {
    process.env.BOOP_TRANSCRIBE_API_KEY = "sk-transcribe";
    let auth: string | null = null;
    stubTranscriber((_url, init) => {
      auth = new Headers(init.headers ?? {}).get("authorization");
      return Response.json({ text: "ok" });
    });
    await transcribe(audioResponse());
    expect(auth).toBe("Bearer sk-transcribe");
  });
});
