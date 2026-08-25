/**
 * Turning a compressed audio file into the PCM a local model can read.
 *
 * This exists because Transformers.js cannot do it in Node. Its `read_audio`
 * decodes through the Web Audio API and throws outright when `AudioContext` is
 * undefined, which it always is here, so a local pipeline has to be handed a
 * `Float32Array` of mono samples at the rate the model wants. Whisper wants
 * 16 kHz.
 *
 * Only the containers a local model can actually be fed are handled, and
 * Ogg/Opus is the one that matters: it is what every Telegram voice note is.
 * The alternative to a WASM Opus decoder was shelling out to ffmpeg, which
 * would have put a system install back in front of the user - the whole thing
 * this path exists to avoid. Anything else (an mp3 or m4a attached as a file)
 * is reported as undecodable rather than guessed at, and a remote transcriber
 * handles those instead because it has ffmpeg behind it.
 */
import { OggOpusDecoder } from "ogg-opus-decoder";
import type { AudioMediaType } from "./mime.js";

/** What Whisper's feature extractor expects. */
export const TARGET_SAMPLE_RATE = 16_000;

export type DecodeResult =
  | { ok: true; samples: Float32Array }
  | { ok: false; reason: string };

/** Whether the in-process decoder can handle a container at all. */
export function canDecodeLocally(mediaType: AudioMediaType): boolean {
  return LOCALLY_DECODABLE.has(mediaType);
}

const LOCALLY_DECODABLE: ReadonlySet<AudioMediaType> = new Set<AudioMediaType>([
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
]);

export async function decodeToMono16k(
  bytes: ArrayBuffer,
  mediaType: AudioMediaType,
): Promise<DecodeResult> {
  if (!canDecodeLocally(mediaType)) {
    return {
      ok: false,
      reason: `${mediaType} cannot be decoded in-process - only Ogg/Opus and WAV can`,
    };
  }
  try {
    const decoded =
      mediaType === "audio/wav" || mediaType === "audio/x-wav"
        ? decodeWav(bytes)
        : await decodeOggOpus(bytes);
    if (decoded.samples.length === 0) return { ok: false, reason: "the audio decoded to silence" };
    return { ok: true, samples: resample(decoded.samples, decoded.sampleRate) };
  } catch (err) {
    return { ok: false, reason: `could not decode ${mediaType}: ${String(err)}` };
  }
}

interface DecodedPcm {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/**
 * Decode Ogg/Opus, mixing to mono.
 *
 * The decoder holds WASM memory, so it is freed on every path. A new instance
 * per call rather than a cached one: decoding is milliseconds against a model
 * load measured in seconds, and a shared instance would have to be guarded
 * against two voice notes arriving at once.
 */
async function decodeOggOpus(bytes: ArrayBuffer): Promise<DecodedPcm> {
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const { channelData, sampleRate } = await decoder.decodeFile(new Uint8Array(bytes));
    return { samples: toMono(channelData), sampleRate };
  } finally {
    decoder.free();
  }
}

/**
 * Decode a WAV, handling only what a transcriber is ever handed: uncompressed
 * PCM, integer or float.
 *
 * Chunks are walked rather than assumed to sit at fixed offsets, because a WAV
 * written by anything other than the simplest encoder carries `LIST` or `fact`
 * chunks ahead of `data`.
 */
function decodeWav(bytes: ArrayBuffer): DecodedPcm {
  const view = new DataView(bytes);
  if (bytes.byteLength < 12 || readTag(view, 0) !== "RIFF" || readTag(view, 8) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const tag = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (tag === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (tag === "data") {
      dataOffset = body;
      // A streamed WAV can carry a placeholder length; trust the file's size.
      dataLength = Math.min(size, bytes.byteLength - body);
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || !channels || !sampleRate) throw new Error("missing fmt or data chunk");

  const interleaved = readSamples(view, dataOffset, dataLength, format, bitsPerSample);
  const perChannel: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const channel = new Float32Array(Math.floor(interleaved.length / channels));
    for (let i = 0; i < channel.length; i++) channel[i] = interleaved[i * channels + c];
    perChannel.push(channel);
  }
  return { samples: toMono(perChannel), sampleRate };
}

function readSamples(
  view: DataView,
  offset: number,
  length: number,
  format: number,
  bitsPerSample: number,
): Float32Array {
  const IEEE_FLOAT = 3;
  if (format === IEEE_FLOAT && bitsPerSample === 32) {
    const out = new Float32Array(Math.floor(length / 4));
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(offset + i * 4, true);
    return out;
  }
  if (bitsPerSample === 16) {
    const out = new Float32Array(Math.floor(length / 2));
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(offset + i * 2, true) / 32768;
    return out;
  }
  if (bitsPerSample === 8) {
    // 8-bit WAV is unsigned, centred on 128.
    const out = new Float32Array(length);
    for (let i = 0; i < out.length; i++) out[i] = (view.getUint8(offset + i) - 128) / 128;
    return out;
  }
  throw new Error(`unsupported WAV sample format (${bitsPerSample}-bit, format ${format})`);
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Average the channels. A voice note is mono already; this is for the rest. */
function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array();
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Resample to 16 kHz by averaging each source window.
 *
 * Averaging rather than picking one sample per window: Opus decodes at 48 kHz,
 * so the common case is dropping two samples in three, and plain decimation
 * would alias everything above 8 kHz down into the speech band. Averaging is a
 * crude low-pass, but it is the difference between clean input and audible
 * artefacts where the model is listening.
 */
function resample(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === TARGET_SAMPLE_RATE) return samples;
  const ratio = sampleRate / TARGET_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = end > start ? sum / (end - start) : (samples[start] ?? 0);
  }
  return out;
}
