import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import {
  isLoopbackAddress,
  isPublicServerRequest,
  isTailnetAddress,
  isTrustedLocalRequest,
} from "../server/local-access.js";

function request({
  headers = {},
  method = "GET",
  remoteAddress = "127.0.0.1",
  url = "/runtime-config",
}: {
  headers?: IncomingHttpHeaders;
  method?: string;
  remoteAddress?: string;
  url?: string;
} = {}) {
  return {
    headers: { host: "localhost:3456", ...headers },
    method,
    socket: { remoteAddress },
    url,
  } as Parameters<typeof isTrustedLocalRequest>[0];
}

/**
 * The gate `server/index.ts` puts in front of every route, reproduced here so
 * that "reachable" and "not reachable" mean the same thing in this file as
 * they do on the server.
 */
function isReachable(req: Parameters<typeof isTrustedLocalRequest>[0]): boolean {
  return isPublicServerRequest(req) || isTrustedLocalRequest(req);
}

// Placeholders. Tailnet addresses are drawn from Tailscale's own ranges, and
// off-tailnet ones from the documentation range reserved for exactly this.
const TAILNET_IPV4 = "100.100.0.20";
const TAILNET_IPV6 = "fd7a:115c:a1e0::20";
const TAILNET_HOST = "boop.tailnet-placeholder.ts.net:3456";
const OFF_TAILNET_IPV4 = "203.0.113.10";

function whatsappWebhook({
  headers = {},
  remoteAddress,
}: {
  headers?: IncomingHttpHeaders;
  remoteAddress: string;
}) {
  return request({
    headers: { host: TAILNET_HOST, ...headers },
    method: "POST",
    remoteAddress,
    url: "/whatsapp/webhook",
  });
}

describe("local server access", () => {
  it("recognizes IPv4, IPv6, and mapped loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.9.8.7")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("203.0.113.10")).toBe(false);
  });

  it("allows direct local and Vite-proxied requests", () => {
    expect(isTrustedLocalRequest(request())).toBe(true);
    expect(
      isTrustedLocalRequest(
        request({
          headers: {
            host: "localhost:5173",
            origin: "http://localhost:5173",
          },
          remoteAddress: "::1",
        }),
      ),
    ).toBe(true);
  });

  it("rejects tunnel, LAN, DNS-rebinding, and cross-origin requests", () => {
    expect(
      isTrustedLocalRequest(
        request({ headers: { "x-forwarded-for": "203.0.113.10" } }),
      ),
    ).toBe(false);
    expect(isTrustedLocalRequest(request({ remoteAddress: "192.168.1.20" }))).toBe(false);
    expect(
      isTrustedLocalRequest(request({ headers: { host: "example.com" } })),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(request({ headers: { host: "example.com@localhost" } })),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(
        request({ headers: { origin: "https://example.com" } }),
      ),
    ).toBe(false);
  });

  it("rejects mixed or spoofed forwarding chains", () => {
    expect(
      isTrustedLocalRequest(
        request({ headers: { "x-forwarded-for": "127.0.0.1, 203.0.113.10" } }),
      ),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(
        request({ headers: { "x-forwarded-host": "localhost, example.com" } }),
      ),
    ).toBe(false);
    expect(
      isTrustedLocalRequest(
        request({ headers: { forwarded: "for=127.0.0.1;host=example.com" } }),
      ),
    ).toBe(false);
  });

  it("exposes only health and provider webhooks publicly", () => {
    expect(isPublicServerRequest(request({ url: "/health?source=desktop" }))).toBe(true);
    expect(
      isPublicServerRequest(request({ method: "POST", url: "/sendblue/webhook/" })),
    ).toBe(true);
    expect(
      isPublicServerRequest(request({ method: "POST", url: "/composio/webhook" })),
    ).toBe(true);
    expect(isPublicServerRequest(request({ method: "POST", url: "/chat" }))).toBe(false);
    expect(isPublicServerRequest(request({ url: "/runtime-config" }))).toBe(false);
    expect(isPublicServerRequest(request({ url: "/composio/toolkits" }))).toBe(false);
    expect(isPublicServerRequest(request({ method: "GET", url: "/sendblue/webhook" }))).toBe(
      false,
    );
  });
});

describe("tailnet addresses", () => {
  // 100.64.0.0/10 is 100.64.x.x through 100.127.x.x. The boundaries are the
  // whole risk here, so they are named rather than sampled.
  it.each([
    ["100.63.255.255", false],
    ["100.64.0.0", true],
    ["100.64.0.1", true],
    ["100.100.0.20", true],
    ["100.127.255.255", true],
    ["100.128.0.0", false],
    ["99.64.0.1", false],
    ["101.64.0.1", false],
    ["100.64.0.256", false],
    ["100.64.0.1:41234", true],
    ["::ffff:100.64.0.1", true],
    ["fd7a:115c:a1e0::1", true],
    ["fd7a:115c:a1e0:1:2:3:4:5", true],
    ["FD7A:115C:A1E0::1", true],
    ["[fd7a:115c:a1e0::1]:41234", true],
    // The same three groups, but `::` puts them at the tail of a different
    // address entirely.
    ["::fd7a:115c:a1e0", false],
    ["fd7b:115c:a1e0::1", false],
    ["fd7a:115c:a1e1::1", false],
    ["fd7a:115c::a1e0:1", false],
    ["fe80::1", false],
    ["2001:db8::1", false],
    ["::1", false],
    ["127.0.0.1", false],
    ["192.168.1.20", false],
    ["203.0.113.10", false],
    ["not-an-address", false],
    ["", false],
  ])("classifies %s", (address, expected) => {
    expect(isTailnetAddress(address)).toBe(expected);
  });

  it("classifies a missing address as off-tailnet", () => {
    expect(isTailnetAddress(undefined)).toBe(false);
  });
});

describe("whatsapp webhook trust boundary", () => {
  it("admits the webhook from loopback and from the tailnet", () => {
    expect(
      isReachable(
        whatsappWebhook({ headers: { host: "localhost:3456" }, remoteAddress: "127.0.0.1" }),
      ),
    ).toBe(true);
    expect(isReachable(whatsappWebhook({ remoteAddress: TAILNET_IPV4 }))).toBe(true);
    expect(isReachable(whatsappWebhook({ remoteAddress: TAILNET_IPV6 }))).toBe(true);
    expect(isReachable(whatsappWebhook({ remoteAddress: `::ffff:${TAILNET_IPV4}` }))).toBe(true);
    expect(
      isReachable(
        request({
          headers: { host: TAILNET_HOST },
          method: "POST",
          remoteAddress: TAILNET_IPV4,
          url: "/whatsapp/webhook/",
        }),
      ),
    ).toBe(true);
  });

  it("refuses the webhook from off the tailnet however it is signed", () => {
    expect(
      isReachable(
        whatsappWebhook({
          // The signing secret the Gateway is registered to send. It is
          // verified further in, and it is deliberately not enough on its own.
          headers: { "x-webhook-secret": "placeholder-secret" },
          remoteAddress: OFF_TAILNET_IPV4,
        }),
      ),
    ).toBe(false);
    expect(isReachable(whatsappWebhook({ remoteAddress: "192.168.1.20" }))).toBe(false);
    expect(isReachable(whatsappWebhook({ remoteAddress: "2001:db8::1" }))).toBe(false);
  });

  it("refuses a forwarding header that claims to have relayed an off-tailnet caller", () => {
    for (const headers of [
      { "x-forwarded-for": OFF_TAILNET_IPV4 },
      { "x-forwarded-for": `${TAILNET_IPV4}, ${OFF_TAILNET_IPV4}` },
      { "x-real-ip": OFF_TAILNET_IPV4 },
      { "cf-connecting-ip": OFF_TAILNET_IPV4 },
      { "true-client-ip": OFF_TAILNET_IPV4 },
      { forwarded: `for=${OFF_TAILNET_IPV4}` },
    ]) {
      expect(isReachable(whatsappWebhook({ headers, remoteAddress: TAILNET_IPV4 }))).toBe(false);
    }
  });

  it("does not let a forwarding header promote an off-tailnet caller onto the tailnet", () => {
    for (const headers of [
      { "x-forwarded-for": TAILNET_IPV4 },
      { "x-real-ip": TAILNET_IPV4 },
      { forwarded: `for=${TAILNET_IPV4}` },
    ]) {
      expect(isReachable(whatsappWebhook({ headers, remoteAddress: OFF_TAILNET_IPV4 }))).toBe(
        false,
      );
    }
  });

  it("admits a relay whose whole chain is on the tailnet", () => {
    expect(
      isReachable(
        whatsappWebhook({
          headers: { "x-forwarded-for": `${TAILNET_IPV4}, 127.0.0.1` },
          remoteAddress: TAILNET_IPV4,
        }),
      ),
    ).toBe(true);
  });

  it("admits only POST on the webhook path", () => {
    expect(
      isReachable(
        request({
          headers: { host: TAILNET_HOST },
          method: "GET",
          remoteAddress: TAILNET_IPV4,
          url: "/whatsapp/webhook",
        }),
      ),
    ).toBe(false);
  });

  it("keeps every other endpoint loopback-only, including from the tailnet", () => {
    for (const [method, url] of [
      ["POST", "/chat"],
      ["GET", "/runtime-config"],
      ["POST", "/runtime-config"],
      ["POST", "/agents/agent-1/retry"],
      ["GET", "/composio/toolkits"],
      ["GET", "/memory/list"],
      ["POST", "/whatsapp/send"],
    ] as const) {
      expect(
        isReachable(
          request({ headers: { host: TAILNET_HOST }, method, remoteAddress: TAILNET_IPV4, url }),
        ),
      ).toBe(false);
    }
    // The WebSocket is gated on this function alone, so a tailnet source must
    // not satisfy it either.
    expect(
      isTrustedLocalRequest(
        request({ headers: { host: TAILNET_HOST }, remoteAddress: TAILNET_IPV4, url: "/ws" }),
      ),
    ).toBe(false);
  });
});
