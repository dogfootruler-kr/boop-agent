/**
 * Resolving an inbound WhatsApp address to a Handle, and deciding whether that
 * Handle is on the Allowlist.
 *
 * This is the sender half of inbound admission. It is exported as plain
 * functions rather than buried in a webhook handler so that its behaviour is
 * exercisable without standing up a server.
 */
import { describeAddress, parseWhatsappAddress } from "./addresses.js";
import { loadWhatsappConfig } from "./config.js";
import { lookupContactAddresses } from "./gateway.js";

export type HandleResolution =
  | { ok: true; handle: string }
  /** A group. Groups never get a Handle, so they never get a Conversation. */
  | { ok: false; reason: "group" }
  /** No phone number could be recovered. The message is dropped. */
  | { ok: false; reason: "unresolvable" };

export type SenderAdmission =
  | { ok: true; handle: string }
  | { ok: false; reason: "group" | "unresolvable" | "not-allowlisted" };

/**
 * Resolve an inbound address to the Handle it belongs to.
 *
 * A `@c.us` address is read directly; a `@lid` address costs a Gateway contact
 * lookup. An address that resolves to nothing is dropped and logged loudly,
 * because the alternative is Boop going quiet on the user with no way to find
 * out why: normalization fails closed, and failing closed is silent.
 */
export async function resolveWhatsappHandle(address: string): Promise<HandleResolution> {
  const parsed = parseWhatsappAddress(address);

  if (parsed.kind === "handle") return { ok: true, handle: parsed.handle };
  // Not logged: being added to a group is an ordinary thing that happens to a
  // phone, and every message in it would otherwise be a line in the log.
  if (parsed.kind === "group") return { ok: false, reason: "group" };

  if (parsed.kind === "lid") {
    const config = loadWhatsappConfig();
    if (config) {
      for (const candidate of await lookupContactAddresses(config, parsed.lid)) {
        // Deliberately the pure parser: a lookup that answers with another
        // `@lid` has told us nothing, and chasing it would loop.
        const resolved = parseWhatsappAddress(candidate);
        if (resolved.kind === "handle") return { ok: true, handle: resolved.handle };
      }
    }
  }

  dropped(address);
  return { ok: false, reason: "unresolvable" };
}

/**
 * Decide whether a sender may reach Boop on the `whatsapp` Channel.
 *
 * Callers must act on this before claiming dedup, before writing anything to
 * Convex, and before spawning an agent. Boop checks this itself even though
 * the Gateway also filters at dispatch, because the security property must not
 * depend on configuration living on a different machine.
 */
export async function admitWhatsappSender(address: string): Promise<SenderAdmission> {
  const resolution = await resolveWhatsappHandle(address);
  if (!resolution.ok) return resolution;

  const config = loadWhatsappConfig();
  if (!config?.allowlist.has(resolution.handle)) {
    console.warn(
      `[whatsapp] refused a message from ${describeAddress(address)}: not on the allowlist`,
    );
    return { ok: false, reason: "not-allowlisted" };
  }
  return { ok: true, handle: resolution.handle };
}

function dropped(address: string): void {
  console.error(
    `[whatsapp] DROPPED an inbound message: sender address ${describeAddress(address)} could not be resolved to a Handle (E.164). ` +
      "Nothing was stored and no agent ran. " +
      "If WhatsApp has changed its address format, server/openwa/addresses.ts is the file to fix.",
  );
}
