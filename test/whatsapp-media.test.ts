import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestWhatsappImage } from "../server/openwa/media.js";

// Placeholder values only - this is a public repo.
const GATEWAY_URL = "http://gateway.example:8080";
const API_KEY = "test-gateway-key";
const CHAT_ID = "15550000101@c.us";
const MESSAGE_ID = "false_15550000101@c.us_ABC123";

const WHATSAPP_ENV = ["WHATSAPP_GATEWAY_URL", "WHATSAPP_API_KEY"] as const;
const originalEnv = new Map(WHATSAPP_ENV.map((key) => [key, process.env[key]]));

function configureWhatsapp(): void {
  process.env.WHATSAPP_GATEWAY_URL = GATEWAY_URL;
  process.env.WHATSAPP_API_KEY = API_KEY;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  configureWhatsapp();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of WHATSAPP_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("ingestWhatsappImage", () => {
  it("requests the Gateway's media endpoint addressed by chat and message ID, authenticated with the API key", async () => {
    // A disallowed content-type is enough to make the shared helper reject
    // early, so this test stays scoped to the request shape and never
    // reaches the Convex upload leg.
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("nope", { status: 200, headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await ingestWhatsappImage(CHAT_ID, MESSAGE_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin).toBe(GATEWAY_URL);
    expect(parsed.pathname).toBe("/api/media");
    expect(parsed.searchParams.get("chatId")).toBe(CHAT_ID);
    expect(parsed.searchParams.get("messageId")).toBe(MESSAGE_ID);
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ "x-api-key": API_KEY });
  });

  it("propagates the shared helper's rejection reason", async () => {
    const fetchMock = vi.fn(
      async () => new Response("nope", { status: 200, headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ingestWhatsappImage(CHAT_ID, MESSAGE_ID);

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/mime|type/i) });
  });

  it("does not call the Gateway when WhatsApp is unconfigured", async () => {
    delete process.env.WHATSAPP_GATEWAY_URL;
    delete process.env.WHATSAPP_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await ingestWhatsappImage(CHAT_ID, MESSAGE_ID);

    expect(result).toEqual({ ok: false, reason: "gateway is not configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a network failure without throwing", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("gateway unreachable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ingestWhatsappImage(CHAT_ID, MESSAGE_ID);

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/download failed/) });
  });
});
