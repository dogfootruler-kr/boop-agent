/**
 * WhatsApp address algebra.
 *
 * Pure syntax only: no Gateway, no configuration, no I/O. This is the file a
 * future WhatsApp address-format change lands in, which is why it has no
 * dependencies and why `test/whatsapp-handles.test.ts` drives it from a table.
 *
 * A Handle is E.164 (`+15550000101`) and is the only form that ever appears in
 * a Conversation ID. WhatsApp's native address is a JID (`15550000101@c.us`),
 * which is reconstructed at send time and is never stored or compared. Without
 * that rule the same person arriving under two address forms would accumulate
 * two separate Conversations.
 */

/**
 * E.164 allows at most 15 digits. The lower bound is a judgement call: no
 * WhatsApp account is reachable on fewer than a country code plus a national
 * number, and being permissive here would let junk resolve to a plausible
 * Handle instead of being dropped and logged.
 */
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/** Suffixes that address one person and therefore can carry a Handle. */
const PERSON_SUFFIXES = new Set(["c.us", "s.whatsapp.net"]);

/** The result of reading an address, before any Gateway lookup. */
export type ParsedAddress =
  /** The address carried a phone number and is already a Handle. */
  | { kind: "handle"; handle: string }
  /** A WhatsApp-internal id. Only the Gateway knows the number behind it. */
  | { kind: "lid"; lid: string }
  /** A group. Groups never get a Handle and are never admitted. */
  | { kind: "group" }
  /** Anything else: a status broadcast, a newsletter, or plain garbage. */
  | { kind: "unresolvable" };

/**
 * Read an address into the one thing Boop can do with it.
 *
 * Accepts the forms a Gateway delivers (`@c.us`, `@g.us`, `@lid`, and the
 * Baileys-style `@s.whatsapp.net`) and the forms a human writes into
 * configuration (bare digits, already-E.164, punctuated). It never guesses a
 * country code: a WhatsApp address is always fully international, so a bare
 * number gets a plain `+` and nothing else.
 */
export function parseWhatsappAddress(raw: string): ParsedAddress {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "unresolvable" };

  const at = trimmed.lastIndexOf("@");
  const suffix = at === -1 ? "" : trimmed.slice(at + 1).toLowerCase();
  // A JID's user part can carry a `:device` suffix on multi-device accounts.
  const user = (at === -1 ? trimmed : trimmed.slice(0, at)).split(":")[0]!;

  if (suffix === "g.us") return { kind: "group" };

  if (suffix === "lid") {
    return /^\d+$/.test(user) ? { kind: "lid", lid: `${user}@lid` } : { kind: "unresolvable" };
  }

  if (suffix === "") {
    // Written by a human, so tolerate the punctuation a human writes.
    const handle = toHandle(user.replace(/[\s().+-]/g, ""));
    return handle ? { kind: "handle", handle } : { kind: "unresolvable" };
  }

  if (PERSON_SUFFIXES.has(suffix)) {
    // Delivered by the Gateway, so the user part is digits or it is not an
    // address we understand. Stripping punctuation here would turn a format we
    // have never seen into a confidently wrong phone number.
    const handle = /^\d+$/.test(user) ? toHandle(user) : null;
    return handle ? { kind: "handle", handle } : { kind: "unresolvable" };
  }

  return { kind: "unresolvable" };
}

/** Reconstruct the Gateway's native address for a Handle, at send time only. */
export function toWhatsappJid(handle: string): string | null {
  const parsed = parseWhatsappAddress(handle);
  if (parsed.kind !== "handle") return null;
  return `${parsed.handle.slice(1)}@c.us`;
}

/**
 * Describe an address for a log line without putting it in the log.
 *
 * A dropped message has to be findable from logs alone, and what makes it
 * findable is the *shape* that arrived, not the number. This is a public repo
 * and these logs get pasted into issues.
 */
export function describeAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "<empty>";
  const at = trimmed.lastIndexOf("@");
  const suffix = at === -1 ? "" : trimmed.slice(at + 1);
  const user = at === -1 ? trimmed : trimmed.slice(0, at);
  const shape = /^\d+$/.test(user)
    ? `<${user.length} digits>`
    : `<${user.length} chars, non-numeric>`;
  return suffix ? `${shape}@${suffix}` : shape;
}

function toHandle(digits: string): string | null {
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
  // No country code starts with 0, so a leading zero means a national-format
  // number arrived and we do not know which country it belongs to.
  if (digits.startsWith("0")) return null;
  return `+${digits}`;
}
