/**
 * HTTP against OpenWA, the Gateway behind the `whatsapp` Channel.
 *
 * Deliberately thin. OpenWA is a reverse-engineered WhatsApp client rather
 * than an official API, so the account-suspension risk is real and the Gateway
 * is expected to be replaced rather than depended on. Three endpoints is the
 * whole surface: send a text, show a typing indication, look up a contact.
 * Nothing here builds on a Gateway-specific feature.
 *
 * Boop does not own the Gateway's lifecycle. It is configured, reachable, and
 * verified; it is not started or supervised.
 */
import { redactContactHandle } from "../privacy.js";
import { toWhatsappJid } from "./addresses.js";
import { loadWhatsappConfig, type WhatsappConfig } from "./config.js";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * WhatsApp clears a typing indication on its own after a short while, so it
 * has to be re-asserted for a turn that takes longer than that to think.
 */
const TYPING_REFRESH_MS = 10_000;

/** OpenWA answers `{ success, data }`. Only `success` is load-bearing here. */
interface GatewayEnvelope {
  success?: boolean;
  data?: unknown;
}

/**
 * Deliver one already-formatted part to a Handle.
 *
 * Phone-number redaction is NOT done here: it runs once in
 * `server/channels/outbound.ts`, above per-channel formatting, so that no
 * Channel adapter can skip it.
 */
export async function sendWhatsappPart(handle: string, part: string): Promise<void> {
  const config = loadWhatsappConfig();
  if (!config) {
    console.warn("[whatsapp] gateway is not configured - not sending");
    return;
  }
  const to = toWhatsappJid(handle);
  if (!to) {
    console.error(
      `[whatsapp] ${redactContactHandle(handle)} is not a Handle (E.164) - not sending`,
    );
    return;
  }

  const res = await post(config, "/api/sendText", { to, content: part });
  if (!res) return;
  if (!res.ok) {
    // The response body is not logged. It echoes the recipient JID back, and
    // this adapter must never be the thing that decides what is safe to print.
    // The status plus a hint covers what the body would have told us anyway.
    console.error(`[whatsapp] send failed ${res.status}`);
    const hint = hintForStatus(res.status);
    if (hint) console.error(`[whatsapp] → ${hint}`);
    return;
  }
  // OpenWA can answer 200 with `success: false`. Reporting that as delivered
  // would make a message that never arrived look like one that did.
  const envelope = (await res.json().catch(() => null)) as GatewayEnvelope | null;
  if (envelope?.success === false) {
    console.error("[whatsapp] the gateway took the request but did not send the message");
    return;
  }
  console.log(`[whatsapp] → sent ${part.length} chars to ${redactContactHandle(handle)}`);
}

/**
 * Show a typing indication to a Handle until the returned function is called.
 */
export function startWhatsappTyping(handle: string): () => void {
  const config = loadWhatsappConfig();
  const to = toWhatsappJid(handle);
  if (!config || !to) return () => {};

  const simulate = (on: boolean) => {
    void post(config, "/api/simulateTyping", { to, on });
  };
  simulate(true);
  const timer = setInterval(() => simulate(true), TYPING_REFRESH_MS);
  return () => {
    clearInterval(timer);
    simulate(false);
  };
}

/**
 * Ask the Gateway which address is behind a WhatsApp-internal id.
 *
 * Only the Gateway can answer this, which is why `@lid` resolution is the one
 * part of Handle normalization that is not pure. Returns the address it
 * reported, still unparsed, or null when it reported nothing usable.
 *
 * The field carrying the phone number has moved between Gateway versions, so
 * every plausible field is offered to the caller in preference order rather
 * than one being trusted. That is a cheap hedge against a Gateway upgrade
 * silently turning every inbound message into a dropped one.
 */
export async function lookupContactAddresses(config: WhatsappConfig, lid: string): Promise<string[]> {
  const url = `${config.baseUrl}/api/contacts/get?contactId=${encodeURIComponent(lid)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": config.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[whatsapp] contact lookup failed: ${String(err)}`);
    return [];
  }
  if (!res.ok) {
    console.error(`[whatsapp] contact lookup failed ${res.status}`);
    return [];
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  const envelope = body as GatewayEnvelope;
  return addressCandidates(envelope?.data ?? body);
}

function addressCandidates(contact: unknown): string[] {
  if (!contact || typeof contact !== "object") return [];
  const record = contact as Record<string, unknown>;
  const out: string[] = [];
  // Explicit phone fields first: for a `@lid` contact, `id` may still be the
  // `@lid` itself, which would resolve to nothing.
  for (const key of ["pn", "phoneNumber", "number", "formattedNumber"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  const id = record.id;
  if (typeof id === "string" && id.trim()) out.push(id.trim());
  else if (id && typeof id === "object") {
    for (const key of ["_serialized", "user"]) {
      const value = (id as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) out.push(value.trim());
    }
  }
  return out;
}

async function post(
  config: WhatsappConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<Response | null> {
  try {
    return await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[whatsapp] ${path} unreachable: ${String(err)}`);
    return null;
  }
}

function hintForStatus(status: number): string | null {
  if (status === 401 || status === 403) {
    return "WHATSAPP_API_KEY was rejected by the gateway.";
  }
  if (status === 404) {
    return "WHATSAPP_GATEWAY_URL should be the gateway root, without a trailing `/api`.";
  }
  if (status === 400 || status === 422) {
    return "The gateway rejected the request. A WhatsApp session that has un-paired reports this way, so check that it is still linked.";
  }
  if (status >= 500) {
    return "The gateway itself errored. Check that it is running and still linked to WhatsApp.";
  }
  return null;
}
