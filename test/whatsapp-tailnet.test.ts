import { describe, expect, it } from "vitest";
import {
  discoverSelfTailnetAddress,
  TailscaleUnavailableError,
} from "../server/openwa/tailnet.js";

// Placeholder tailnet addresses only - never a real host or MagicDNS name.
const TAILNET_IPV4 = "100.101.102.5";
const NON_TAILNET_IPV4 = "192.168.1.5";

function statusJson(ips: string[]): string {
  return JSON.stringify({ Self: { TailscaleIPs: ips } });
}

describe("discoverSelfTailnetAddress", () => {
  it("returns the address from the local Tailscale node's own status", async () => {
    const runStatus = async () => statusJson([TAILNET_IPV4]);

    await expect(discoverSelfTailnetAddress({ runStatus })).resolves.toBe(TAILNET_IPV4);
  });

  it("picks the tailnet address when the node also reports a non-tailnet one", async () => {
    const runStatus = async () => statusJson([NON_TAILNET_IPV4, TAILNET_IPV4]);

    await expect(discoverSelfTailnetAddress({ runStatus })).resolves.toBe(TAILNET_IPV4);
  });

  it("uses the override without invoking Tailscale at all", async () => {
    const runStatus = async () => {
      throw new Error("should not be called when an override is given");
    };

    await expect(
      discoverSelfTailnetAddress({ override: TAILNET_IPV4, runStatus }),
    ).resolves.toBe(TAILNET_IPV4);
  });

  it("rejects an override that is not actually a tailnet address", async () => {
    await expect(
      discoverSelfTailnetAddress({ override: NON_TAILNET_IPV4 }),
    ).rejects.toBeInstanceOf(TailscaleUnavailableError);
  });

  it("fails loudly, not silently, when the local Tailscale node cannot be reached", async () => {
    const runStatus = async () => {
      throw new Error("spawn tailscale ENOENT");
    };

    await expect(discoverSelfTailnetAddress({ runStatus })).rejects.toThrow(
      TailscaleUnavailableError,
    );
    await expect(discoverSelfTailnetAddress({ runStatus })).rejects.toThrow(
      /could not reach the local tailscale node/i,
    );
  });

  it("fails loudly when Tailscale is up but reports no tailnet address for this node", async () => {
    const runStatus = async () => statusJson([NON_TAILNET_IPV4]);

    await expect(discoverSelfTailnetAddress({ runStatus })).rejects.toThrow(
      TailscaleUnavailableError,
    );
  });

  it("fails loudly when Tailscale's output cannot be parsed as JSON", async () => {
    const runStatus = async () => "not json";

    await expect(discoverSelfTailnetAddress({ runStatus })).rejects.toThrow(
      TailscaleUnavailableError,
    );
  });
});
