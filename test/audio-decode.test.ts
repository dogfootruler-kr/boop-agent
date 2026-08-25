import { describe, expect, it } from "vitest";
import { canDecodeLocally, decodeToMono16k, TARGET_SAMPLE_RATE } from "../server/audio/decode.js";

/**
 * 0.3s of a 440Hz sine, encoded as Ogg/Opus by ffmpeg at 12kbps - the same
 * container and codec Telegram sends every voice note in.
 *
 * Embedded as base64 rather than checked in as a binary so the fixture is
 * readable, and synthesised rather than recorded so it carries nothing but a
 * tone.
 */
const TONE_OGG_BASE64 =
  "T2dnUwACAAAAAAAAAAAReMk8AAAAABqdDgABE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAABF4yTwBAAAA" +
  "PmJhhQE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAxAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMSBsaWJvcHVzT2dn" +
  "UwAEeDkAAAAAAAAReMk8AgAAAPCrSboQMiUmKyopJSwnNDUvJistFUiCLrdsVrf0AAHlzZ4BRlCFl7c8k8kXWcMRmkHf" +
  "AJ7y1zq2I4vf3+wAQ10tcJaaf1ZkSKSIV6yYhQNcJgmTMSfxOknsN8ygvcPpG5M4ORqlyKT+6XVr4EicG1JRRQCs4tS0" +
  "q5heSeVOy41n0ycwsDdwE0cBiyqcHEO2RA/2SJwbUlbOH+oQyrkcVJlQuXZMuRp8D7IgsrBlD9hCDimoaBzULtR5QIyQ" +
  "qkicG591nPxJM79GiLaL4zcMmuxs3VZPkze1aGGz5zXd/b/VaNywrZAPgEicG1dL3baUmnq1Z8xfCKYHverFcnW2fQdP" +
  "9bzbPbSTe6sP9K6ft6y/SJwbn3Wc/EXvXtDeCxrPFGoiNEJrfEZYzwKbgnTmvVXdATx+EEicG1dRXyWjjDQZnRYvDFIr" +
  "05/owGfHMGCCz7PmYx4c7lqVxaTe3tbEwCKgSJwbUlbOH+oHBoSYz4cA+GLPYZyP1GHB5K9cwK+mOGZsLktZt1GtSJwb" +
  "UbQcv6K94gagj5A1g7kN8ZdwN1PcfWW+iDr8P0+MqV2pSjLX8FWtO87XPiLkHsAkgEicG1dm2lHtq3tizIaONedAWRC+" +
  "pJBf9aJOyh01OA/XHAX51I6uXx8AsU9RQBqVxYsrM/BgSJyTkbQcv6i2q7fTGzNaDAjUEc+WWNRf1KhsdfisZFN8rYCo" +
  "MjQ15Mnz73oGROBInJOSVs4jdnLE/MGzrJukGIA+lzIbGkX8iBxe5Fhx7sUYZRN/cEick5JWziIpeAS3WXbOWQXRhHmJ" +
  "lziPBqwXIFIBXJL+tpeq1Npti6oeToBInJOSVs4iGy/AJzIw0vmP0sOewbH+RrNndBrzgt8onWDgGyPoHAia5yOmk4BI" +
  "Bhnl8BHniBW2kBcm/dffmHnqKhA=";

function bytes(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** A minimal 16-bit PCM WAV, for the branch that does not go through Opus. */
function wav(samples: Float32Array, sampleRate: number, channels = 1): ArrayBuffer {
  const body = samples.length * 2;
  const buf = new ArrayBuffer(44 + body);
  const view = new DataView(buf);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + body, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, body, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  }
  return buf;
}

function tone(seconds: number, sampleRate: number, hz = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

describe("canDecodeLocally", () => {
  it("covers what Telegram voice notes actually are", () => {
    expect(canDecodeLocally("audio/ogg")).toBe(true);
    expect(canDecodeLocally("audio/wav")).toBe(true);
  });

  it("does not claim formats that would need ffmpeg", () => {
    // Claiming these would put a system install back in front of the user,
    // which is the whole thing the in-process path exists to avoid.
    expect(canDecodeLocally("audio/mpeg")).toBe(false);
    expect(canDecodeLocally("audio/mp4")).toBe(false);
  });
});

describe("decodeToMono16k", () => {
  it("decodes real Ogg/Opus down to 16kHz mono", async () => {
    const result = await decodeToMono16k(bytes(TONE_OGG_BASE64), "audio/ogg");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Opus always decodes at 48kHz, so this also proves the resample ran.
    // Opus pads the front of the stream, so the length is approximate.
    expect(result.samples.length).toBeGreaterThan(0.25 * TARGET_SAMPLE_RATE);
    expect(result.samples.length).toBeLessThan(0.45 * TARGET_SAMPLE_RATE);
    expect(result.samples.some((s) => s !== 0)).toBe(true);
  });

  it("refuses a container it has no decoder for", async () => {
    const result = await decodeToMono16k(bytes(TONE_OGG_BASE64), "audio/mpeg");
    expect(result).toMatchObject({ ok: false });
  });

  it("reports a corrupt file rather than throwing", async () => {
    const result = await decodeToMono16k(new TextEncoder().encode("nope").buffer, "audio/ogg");
    expect(result).toMatchObject({ ok: false });
  });

  it("passes 16kHz WAV through at its own length", async () => {
    const result = await decodeToMono16k(wav(tone(0.5, 16_000), 16_000), "audio/wav");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.samples.length).toBe(8000);
  });

  it("resamples a 48kHz WAV down to 16kHz", async () => {
    const result = await decodeToMono16k(wav(tone(0.5, 48_000), 48_000), "audio/wav");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.samples.length).toBe(8000);
  });

  it("resamples a non-integer ratio without running off the end", async () => {
    // 44.1kHz is not a whole multiple of 16kHz, which is where an off-by-one
    // in the window arithmetic would show up as a trailing NaN.
    const result = await decodeToMono16k(wav(tone(0.5, 44_100), 44_100), "audio/wav");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.samples.length).toBe(8000);
    expect(result.samples.every((s) => Number.isFinite(s))).toBe(true);
  });

  it("mixes a stereo WAV down to one channel", async () => {
    const left = tone(0.25, 16_000, 440);
    const interleaved = new Float32Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      interleaved[i * 2] = left[i];
      interleaved[i * 2 + 1] = -left[i]; // opposite phase: a correct mix cancels
    }
    const result = await decodeToMono16k(wav(interleaved, 16_000, 2), "audio/wav");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.samples.length).toBe(left.length);
    expect(Math.max(...result.samples.map(Math.abs))).toBeLessThan(0.01);
  });

  it("reports silence as undecodable rather than transcribing nothing", async () => {
    const result = await decodeToMono16k(wav(new Float32Array(0), 16_000), "audio/wav");
    expect(result).toMatchObject({ ok: false });
  });

  it("skips over a LIST chunk sitting before the data chunk", async () => {
    // Anything but the simplest encoder writes one, and assuming fixed
    // offsets would read metadata as audio.
    const plain = new Uint8Array(wav(tone(0.25, 16_000), 16_000));
    const listBody = 8;
    const withList = new Uint8Array(plain.length + 8 + listBody);
    withList.set(plain.subarray(0, 36), 0);
    const view = new DataView(withList.buffer);
    for (let i = 0; i < 4; i++) view.setUint8(36 + i, "LIST".charCodeAt(i));
    view.setUint32(40, listBody, true);
    withList.set(plain.subarray(36), 44 + listBody);
    view.setUint32(4, withList.length - 8, true);
    const result = await decodeToMono16k(withList.buffer, "audio/wav");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.samples.length).toBe(4000);
  });
});
