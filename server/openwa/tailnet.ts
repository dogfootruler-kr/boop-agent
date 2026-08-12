/**
 * Discovering Boop's own address on the tailnet.
 *
 * OpenWA needs an address to deliver inbound WhatsApp messages to. That
 * address is queried from the LOCAL Tailscale node - `tailscale status
 * --json` - never from anything that reaches the internet, and it is sanity
 * checked with `isTailnetAddress` from `server/local-access.ts` before it is
 * trusted.
 *
 * This module only discovers the address. Registering it with the Gateway is
 * a separate concern (see the issue tracker for the follow-up ticket); this
 * function is exported so that step can call it directly.
 */
import { execFile } from "node:child_process";
import { isTailnetAddress } from "../local-access.js";

/** The escape hatch: skips discovery entirely when the local query cannot be trusted or used. */
export const BOOP_TAILNET_ADDRESS_ENV = "BOOP_TAILNET_ADDRESS";

/**
 * Tailscale is unreachable, not installed, not logged in, or reported no
 * tailnet address. Thrown with an actionable `message` rather than returning
 * null, because a silent failure here means OpenWA gets registered against an
 * address nothing can reach, and the operator finds out only when their first
 * message vanishes.
 */
export class TailscaleUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TailscaleUnavailableError";
  }
}

interface TailscaleStatus {
  Self?: { TailscaleIPs?: string[] };
}

/** Runs `tailscale status --json` and returns its stdout. Swappable for tests. */
export type TailscaleStatusRunner = () => Promise<string>;

function runTailscaleStatus(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("tailscale", ["status", "--json"], { timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout);
    });
  });
}

/**
 * Work out the tailnet address Boop should tell the Gateway to reach it on.
 *
 * An explicit override always wins - it is the escape hatch for a Tailscale
 * setup this cannot query (a subnet router, a renamed CLI, a container that
 * cannot exec `tailscale`). Otherwise this asks the local Tailscale node for
 * its own status and picks the address from it that is actually on the
 * tailnet, reusing `isTailnetAddress` rather than trusting the CLI blindly.
 *
 * Throws `TailscaleUnavailableError` rather than returning null so the caller
 * can fail loudly with a message meant to be read, not a stack trace.
 */
export async function discoverSelfTailnetAddress(
  options: { override?: string; runStatus?: TailscaleStatusRunner } = {},
): Promise<string> {
  const override = options.override?.trim();
  if (override) {
    if (!isTailnetAddress(override)) {
      throw new TailscaleUnavailableError(
        `${BOOP_TAILNET_ADDRESS_ENV} is set to "${override}", which is not a Tailscale tailnet address. ` +
          "It should look like 100.x.x.x (Tailscale's IPv4 CGNAT range) or an fd7a:115c:a1e0::/48 IPv6 address.",
      );
    }
    return override;
  }

  const runStatus = options.runStatus ?? runTailscaleStatus;
  let raw: string;
  try {
    raw = await runStatus();
  } catch (err) {
    throw new TailscaleUnavailableError(
      "Could not reach the local Tailscale node (`tailscale status --json` failed). " +
        "Install Tailscale (https://tailscale.com/download), make sure it's running and logged in " +
        `(\`tailscale up\`), then try again - or set ${BOOP_TAILNET_ADDRESS_ENV} to this machine's ` +
        "tailnet address to skip the check.",
      { cause: err },
    );
  }

  let status: TailscaleStatus;
  try {
    status = JSON.parse(raw) as TailscaleStatus;
  } catch (err) {
    throw new TailscaleUnavailableError(
      "`tailscale status --json` returned output Boop could not parse as JSON. " +
        `Run it yourself to see what's wrong, or set ${BOOP_TAILNET_ADDRESS_ENV} to skip the check.`,
      { cause: err },
    );
  }

  const address = (status.Self?.TailscaleIPs ?? []).find((ip) => isTailnetAddress(ip));
  if (!address) {
    throw new TailscaleUnavailableError(
      "Tailscale is running but reported no tailnet address for this node. " +
        `Run \`tailscale status --json\` yourself to check, or set ${BOOP_TAILNET_ADDRESS_ENV} directly.`,
    );
  }
  return address;
}
