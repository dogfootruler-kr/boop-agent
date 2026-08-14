import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

type RequestLike = Pick<IncomingMessage, "headers" | "method" | "socket" | "url">;

function headerValues(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizedAddress(value: string | undefined): string {
  if (!value) return "";

  let address = stripQuotes(value).trim().toLowerCase();
  if (address.startsWith("[")) {
    const closingBracket = address.indexOf("]");
    if (closingBracket !== -1) {
      address = address.slice(1, closingBracket);
    }
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(":"));
  }

  if (address.startsWith("::ffff:")) {
    address = address.slice("::ffff:".length);
  }
  return address;
}

export function isLoopbackAddress(value: string | undefined): boolean {
  const address = normalizedAddress(value);
  return (
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(address)
  );
}

/**
 * Expands an IPv6 address to its eight groups, or null when it is not one.
 *
 * A prefix cannot be compared against the text of an address, because `::`
 * moves the groups: `fd7a:115c:a1e0::1` and `::fd7a:115c:a1e0` share a
 * substring and share no prefix at all.
 */
function ipv6Groups(address: string): number[] | null {
  if (!address.includes(":")) return null;

  const halves = address.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const written = [...head, ...tail];
  if (!written.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;

  if (halves.length === 1) {
    return written.length === 8 ? written.map((group) => parseInt(group, 16)) : null;
  }
  if (written.length >= 8) return null;
  const elided = Array<string>(8 - written.length).fill("0");
  return [...head, ...elided, ...tail].map((group) => parseInt(group, 16));
}

/** Tailscale's IPv6 range for a tailnet: `fd7a:115c:a1e0::/48`. */
const TAILNET_IPV6_PREFIX = [0xfd7a, 0x115c, 0xa1e0];

/**
 * Whether an address belongs to a Tailscale tailnet.
 *
 * Tailscale hands every node an IPv4 address in the CGNAT range
 * `100.64.0.0/10`, which is `100.64.x.x` through `100.127.x.x`, and an IPv6
 * address in `fd7a:115c:a1e0::/48`.
 *
 * Recognizing a tailnet address is not the same as trusting one.
 * `isTrustedLocalRequest` stays loopback-only on purpose; the only thing this
 * unlocks is the Gateway webhook path listed in `isPublicServerRequest`. Read
 * `docs/adr/0002-inbound-trust-boundary.md` before widening it.
 */
export function isTailnetAddress(value: string | undefined): boolean {
  const address = normalizedAddress(value);

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (octets) {
    const parsed = octets.slice(1).map(Number);
    if (parsed.some((octet) => octet > 255)) return false;
    return parsed[0] === 100 && parsed[1] >= 64 && parsed[1] <= 127;
  }

  const groups = ipv6Groups(address);
  if (!groups) return false;
  return TAILNET_IPV6_PREFIX.every((group, index) => groups[index] === group);
}

function isLocalAuthority(value: string | undefined): boolean {
  if (!value) return false;

  const authority = stripQuotes(value).trim().toLowerCase();
  if (authority.includes("@")) return false;
  try {
    const hostname = new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "localhost." || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

/** Every source address a forwarding header claims the request came from. */
function forwardedSourceAddresses(headers: IncomingHttpHeaders): string[] {
  const forwardedFor = headerValues(headers["x-forwarded-for"]).flatMap((value) =>
    value.split(","),
  );
  const singleAddressHeaders = [
    ...headerValues(headers["x-real-ip"]),
    ...headerValues(headers["cf-connecting-ip"]),
    ...headerValues(headers["true-client-ip"]),
  ];

  return [...forwardedFor, ...singleAddressHeaders, ...forwardedParameters(headers, "for")].map(
    (value) => value.trim(),
  );
}

function allForwardedAddressesAreLoopback(headers: IncomingHttpHeaders): boolean {
  return forwardedSourceAddresses(headers).every(isLoopbackAddress);
}

function allForwardedHostsAreLocal(headers: IncomingHttpHeaders): boolean {
  return headerValues(headers["x-forwarded-host"])
    .flatMap((value) => value.split(","))
    .every((value) => isLocalAuthority(value.trim()));
}

/** The values of one parameter across every element of the `Forwarded` header. */
function forwardedParameters(headers: IncomingHttpHeaders, key: string): string[] {
  const values: string[] = [];
  for (const value of headerValues(headers.forwarded)) {
    for (const entry of value.split(",")) {
      for (const parameter of entry.split(";")) {
        const separator = parameter.indexOf("=");
        if (separator === -1) continue;
        if (parameter.slice(0, separator).trim().toLowerCase() !== key) continue;
        values.push(parameter.slice(separator + 1).trim());
      }
    }
  }
  return values;
}

function forwardedHeaderHostsAreLocal(headers: IncomingHttpHeaders): boolean {
  return forwardedParameters(headers, "host").every(isLocalAuthority);
}

function hasTrustedOrigin(headers: IncomingHttpHeaders): boolean {
  const origins = headerValues(headers.origin);
  if (origins.length === 0) return true;

  return origins.every((origin) => {
    try {
      return isLocalAuthority(new URL(origin).host);
    } catch {
      return false;
    }
  });
}

export function isTrustedLocalRequest(request: RequestLike): boolean {
  return (
    isLoopbackAddress(request.socket.remoteAddress) &&
    isLocalAuthority(request.headers.host) &&
    hasTrustedOrigin(request.headers) &&
    allForwardedAddressesAreLoopback(request.headers) &&
    allForwardedHostsAreLocal(request.headers) &&
    forwardedHeaderHostsAreLocal(request.headers)
  );
}

/**
 * Whether the request really reached us from loopback or from the tailnet.
 *
 * The socket address is the only source a caller cannot choose for itself, so
 * it decides. A forwarding header can then only ever narrow the answer: a
 * proxy on the tailnet that admits it relayed an off-tailnet caller is
 * refused, and one that claims a tailnet origin while dialling in from
 * somewhere else was already refused by the socket address. That is the whole
 * point - an `X-Forwarded-For` anyone can write must not be able to promote a
 * caller into the tailnet.
 *
 * No host or origin check applies here. A request from the tailnet legitimately
 * carries the tailnet name of this machine as its `Host`, and the one path
 * this guards further checks a shared secret further in.
 */
function isTailnetOrLoopbackRequest(request: RequestLike): boolean {
  const trusted = (value: string | undefined) =>
    isLoopbackAddress(value) || isTailnetAddress(value);

  return (
    trusted(request.socket.remoteAddress) &&
    forwardedSourceAddresses(request.headers).every(trusted)
  );
}

export function isPublicServerRequest(request: RequestLike): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }

  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  if (request.method === "GET" && normalizedPath === "/health") return true;
  if (request.method === "POST" && normalizedPath === "/sendblue/webhook") return true;
  if (request.method === "POST" && normalizedPath === "/composio/webhook") return true;

  // The `whatsapp` Channel's inbound path. Its Gateway, OpenWA, runs on the
  // user's own hardware on the user's own tailnet, so unlike Sendblue it never
  // needs to reach Boop over the public internet. The path is on this list AND
  // additionally restricted to loopback or tailnet sources: both, not either.
  // Every call must also carry the shared secret checked in
  // `server/openwa/webhook-auth.ts`, and that secret is deliberately not
  // sufficient on its own - a leaked secret must not be enough to reach the
  // agent, the user's memory, and every connected integration. Read
  // `docs/adr/0002-inbound-trust-boundary.md`.
  if (request.method === "POST" && normalizedPath === "/whatsapp/webhook") {
    return isTailnetOrLoopbackRequest(request);
  }

  return false;
}
