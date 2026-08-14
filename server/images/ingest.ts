/**
 * The part of inbound image ingest that is genuinely identical across
 * Gateways: the streaming size cap, the MIME check, and the upload to Convex
 * storage.
 *
 * Deliberately not part of the `Channel` port and deliberately not a single
 * ingest function. Sendblue serves media from an unauthenticated CDN URL;
 * OpenWA requires an authenticated request addressed by chat and message ID.
 * Those two fetches stay as two separate entry points, one per Gateway
 * (`ingestSendblueImage` in `server/sendblue.ts`, `ingestWhatsappImage` in
 * `server/openwa/media.ts`), each of which does its own fetch and then hands
 * the resulting `Response` to `ingestImageFromResponse` here.
 */
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { MAX_IMAGE_BYTES, validateImageHeader, type ImageMediaType } from "./mime.js";

const UPLOAD_TIMEOUT_MS = 10_000;

export interface IngestedImage {
  readonly storageId: string;
  readonly mediaType: ImageMediaType;
}

export type ImageIngestResult =
  | { ok: true; image: IngestedImage }
  | { ok: false; reason: string };

/**
 * Validate, cap, and persist an already-fetched image response to Convex
 * storage.
 *
 * The caller owns the fetch (and therefore the auth, the URL shape, and the
 * network-level error handling) and hands this an ordinary `Response`. Body
 * bytes are streamed rather than buffered with `res.arrayBuffer()`, so an
 * oversized response is aborted mid-download instead of buffered in full
 * first - `content-length` is often absent on CDN/redirect responses, so the
 * running total is what actually enforces the cap.
 */
export async function ingestImageFromResponse(res: Response): Promise<ImageIngestResult> {
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `download failed: HTTP ${res.status}` };
  }
  const lenHeader = res.headers.get("content-length");
  const contentLength = lenHeader ? Number(lenHeader) : undefined;
  const check = validateImageHeader({
    contentType: res.headers.get("content-type") ?? undefined,
    contentLength,
  });
  if (!check.ok) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: check.reason };
  }

  let buf: ArrayBuffer;
  try {
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: "download failed: no body" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          reason: `image too large: >${MAX_IMAGE_BYTES} bytes`,
        };
      }
      chunks.push(value);
    }
    buf = new ArrayBuffer(total);
    const view = new Uint8Array(buf);
    let offset = 0;
    for (const c of chunks) {
      view.set(c, offset);
      offset += c.byteLength;
    }
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }

  try {
    const uploadUrl = await convex.mutation(api.messages.generateUploadUrl, {});
    const upload = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": check.mediaType },
      body: buf,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!upload.ok) {
      return { ok: false, reason: `upload failed: HTTP ${upload.status}` };
    }
    const { storageId } = (await upload.json()) as { storageId: string };
    return { ok: true, image: { storageId, mediaType: check.mediaType } };
  } catch (err) {
    return { ok: false, reason: `upload failed: ${String(err)}` };
  }
}
