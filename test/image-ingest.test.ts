import { describe, expect, it } from "vitest";
import { ingestImageFromResponse } from "../server/images/ingest.js";
import { MAX_IMAGE_BYTES } from "../server/images/mime.js";

/** A response whose entire body is available up front. */
function fixedBodyResponse(
  body: Uint8Array,
  init: { contentType?: string; contentLength?: number | null; status?: number } = {},
): Response {
  const headers: Record<string, string> = {};
  if (init.contentType !== undefined) headers["content-type"] = init.contentType;
  if (init.contentLength !== undefined && init.contentLength !== null) {
    headers["content-length"] = String(init.contentLength);
  }
  return new Response(body as BodyInit, { status: init.status ?? 200, headers });
}

/**
 * A response that streams more bytes than declared (or than any header says
 * at all), the way a CDN or a redirecting Gateway response can. This is what
 * exercises the running-total cap rather than the header-only check that
 * `validateImageHeader` already covers on its own.
 */
function streamedBodyResponse(totalBytes: number, contentType = "image/png"): Response {
  const CHUNK_BYTES = 1024 * 1024;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK_BYTES, totalBytes - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": contentType } });
}

describe("ingestImageFromResponse", () => {
  it("rejects a disallowed MIME type without reading the body", async () => {
    const result = await ingestImageFromResponse(
      fixedBodyResponse(new Uint8Array([1, 2, 3]), { contentType: "application/pdf" }),
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/mime|type/i) });
  });

  it("rejects a declared content-length over the cap before streaming anything", async () => {
    const result = await ingestImageFromResponse(
      fixedBodyResponse(new Uint8Array([1, 2, 3]), {
        contentType: "image/png",
        contentLength: MAX_IMAGE_BYTES + 1,
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/too large|size/i) });
  });

  it("rejects a stream that exceeds the cap even with no content-length header", async () => {
    const result = await ingestImageFromResponse(
      streamedBodyResponse(MAX_IMAGE_BYTES + 1024 * 1024),
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/too large/i) });
  });

  it("rejects a non-ok response without inspecting headers", async () => {
    const result = await ingestImageFromResponse(
      fixedBodyResponse(new Uint8Array(), { contentType: "image/png", status: 502 }),
    );
    expect(result).toEqual({ ok: false, reason: "download failed: HTTP 502" });
  });

  it("rejects a response missing content-type", async () => {
    const result = await ingestImageFromResponse(fixedBodyResponse(new Uint8Array([1])));
    expect(result).toMatchObject({ ok: false });
  });
});
