/**
 * Configuration for the `whatsapp` Channel's Gateway, OpenWA.
 *
 * Read from local environment only. Every value here is either an address on
 * the user's own tailnet or a secret, so none of it belongs in a committed
 * file. `.env.example` carries placeholders.
 *
 * Loading is silent and side-effect free: it is called per outbound message,
 * so it reports nothing. `registerWhatsappChannel` in
 * `server/channels/whatsapp.ts` is the one place that says out loud what was
 * and was not configured.
 */
import { describeAddress, parseWhatsappAddress } from "./addresses.js";

export interface WhatsappConfig {
  /** Gateway root on the tailnet, without a trailing slash and without `/api`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * Which Gateway session Boop is bound to. One session, stated rather than
   * assumed. The adapter does not need it to send; webhook registration and
   * inbound attribution do.
   */
  readonly sessionId?: string;
  /**
   * The Handles Boop accepts an inbound message from on this Channel.
   *
   * A security boundary, not a preference, and not a permission system: it is
   * a flat set with no notion of who a Handle belongs to. Read the Allowlist
   * section of `CONTEXT.md` before adding a second person to it.
   */
  readonly allowlist: ReadonlySet<string>;
  /** Optional override for the Gateway account's own address, as a Handle. */
  readonly selfHandle?: string;
  /** Human-readable configuration complaints, for the registration log. */
  readonly problems: readonly string[];
}

/**
 * Read the Gateway configuration, or return null when there is none.
 *
 * Null means the `whatsapp` Channel is absent, not broken. A Gateway URL and
 * an API key are what it takes to reach OpenWA at all; everything else is
 * reported as a problem and left to the caller.
 */
export function loadWhatsappConfig(): WhatsappConfig | null {
  const env = process.env;
  const baseUrl = env.WHATSAPP_GATEWAY_URL?.trim();
  const apiKey = env.WHATSAPP_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;

  const problems: string[] = [];
  const { handles, rejected } = parseAllowlist(env.WHATSAPP_ALLOWLIST);
  for (const entry of rejected) {
    problems.push(
      `WHATSAPP_ALLOWLIST entry ${entry} is not a phone number and was ignored - write it as E.164 (+15550000101) or as a \`@c.us\` JID`,
    );
  }
  if (handles.size === 0) {
    problems.push(
      "WHATSAPP_ALLOWLIST is empty - every inbound WhatsApp message will be dropped",
    );
  }

  const sessionId = env.WHATSAPP_SESSION_ID?.trim() || undefined;
  if (!sessionId) {
    problems.push("WHATSAPP_SESSION_ID is not set - webhook registration needs it");
  }

  const rawSelf = env.WHATSAPP_SELF_ADDRESS?.trim();
  let selfHandle: string | undefined;
  if (rawSelf) {
    const parsed = parseWhatsappAddress(rawSelf);
    if (parsed.kind === "handle") selfHandle = parsed.handle;
    else problems.push("WHATSAPP_SELF_ADDRESS is not a phone number and was ignored");
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    sessionId,
    allowlist: handles,
    selfHandle,
    problems,
  };
}

/**
 * Normalize Allowlist entries to Handles at load time.
 *
 * An entry may be written as E.164 or as a raw JID, whichever the user finds
 * convenient; both land on the same Handle, so the user never has to know
 * WhatsApp's internal address format. A group JID is refused here as well as
 * at admission, because an Allowlist is a set of people.
 *
 * A `@lid` entry is refused too: resolving one needs a live Gateway contact
 * lookup, and an Allowlist that only loads correctly when the Gateway happens
 * to be up is worse than one that tells the user to write their number.
 *
 * Entries are separated by a comma, a semicolon, or a newline, and not by a
 * space: `+1 (555) 000-0101` is a way people write a phone number, and
 * splitting it into three entries would reject a number that is perfectly
 * clear to the person who wrote it.
 */
function parseAllowlist(raw: string | undefined): { handles: Set<string>; rejected: string[] } {
  const handles = new Set<string>();
  const rejected: string[] = [];
  for (const candidate of (raw ?? "").split(/[,;\n]+/)) {
    const entry = candidate.trim();
    if (!entry) continue;
    const parsed = parseWhatsappAddress(entry);
    if (parsed.kind === "handle") handles.add(parsed.handle);
    else rejected.push(describeAddress(entry));
  }
  return { handles, rejected };
}
