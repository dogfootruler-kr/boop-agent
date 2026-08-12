import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWhatsappWebhook } from "../server/openwa/webhook-registration.js";
import {
  deriveWhatsappWebhookSecret,
  WHATSAPP_WEBHOOK_SECRET_HEADER,
} from "../server/openwa/webhook-auth.js";

// Placeholder hosts, keys, and numbers only - this is a public repo.
const GATEWAY_URL = "http://gateway.example:8080";
const API_KEY = "test-gateway-key";
const SESSION_ID = "boop";
const ALLOWED = ["+", "1", "555", "000", "0101"].join("");
const ALLOWED_JID = `${ALLOWED.slice(1)}@c.us`;
const TAILNET_ADDRESS = "100.101.102.5";
const PORT = "3456";
const EXPECTED_WEBHOOK_URL = `http://${TAILNET_ADDRESS}:${PORT}/whatsapp/webhook`;

const MANAGED_ENV = [
  "WHATSAPP_GATEWAY_URL",
  "WHATSAPP_API_KEY",
  "WHATSAPP_SESSION_ID",
  "WHATSAPP_ALLOWLIST",
  "BOOP_TAILNET_ADDRESS",
  "PORT",
] as const;

const originalEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));

function configureWhatsapp(): void {
  process.env.WHATSAPP_GATEWAY_URL = GATEWAY_URL;
  process.env.WHATSAPP_API_KEY = API_KEY;
  process.env.WHATSAPP_SESSION_ID = SESSION_ID;
  process.env.WHATSAPP_ALLOWLIST = ALLOWED;
  process.env.BOOP_TAILNET_ADDRESS = TAILNET_ADDRESS;
  process.env.PORT = PORT;
}

interface GatewayCall {
  readonly pathname: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown> | undefined;
}

/**
 * A stubbed OpenWA that remembers what has been registered with it.
 *
 * Statefulness is the point: the idempotency test starts Boop twice against
 * the same stub, so the second startup sees whatever the first one left.
 */
function stubGateway(options: { state?: string } = {}) {
  const webhooks: Array<Record<string, unknown>> = [];
  const calls: GatewayCall[] = [];

  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const pathname = new URL(String(input)).pathname;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ pathname, init, body });

    switch (pathname) {
      case "/api/session/getConnectionState":
        return json({ success: true, data: { state: options.state ?? "CONNECTED" } });
      case "/api/webhooks/list":
        return json({ success: true, data: webhooks });
      case "/api/webhooks/register":
        webhooks.push(body!);
        return json({ success: true, data: body });
      case "/api/webhooks/update": {
        const index = webhooks.findIndex((w) => w.id === body!.id);
        if (index >= 0) webhooks[index] = body!;
        else webhooks.push(body!);
        return json({ success: true, data: body });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    webhooks,
    fetchMock,
    callsTo: (pathname: string) => calls.filter((call) => call.pathname === pathname),
  };
}

let warnings: string[];

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  configureWhatsapp();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of MANAGED_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("ensureWhatsappWebhook", () => {
  it("registers Boop's tailnet address with the Gateway, signed with the derived secret", async () => {
    const gateway = stubGateway();

    await expect(ensureWhatsappWebhook()).resolves.toEqual({
      status: "registered",
      url: EXPECTED_WEBHOOK_URL,
    });

    const registrations = gateway.callsTo("/api/webhooks/register");
    expect(registrations).toHaveLength(1);
    const [registration] = registrations;
    expect(registration.init.method).toBe("POST");
    expect(registration.init.headers).toMatchObject({ "x-api-key": API_KEY });
    expect(registration.body).toMatchObject({
      url: EXPECTED_WEBHOOK_URL,
      events: ["message.received"],
      sessionId: SESSION_ID,
      headers: {
        [WHATSAPP_WEBHOOK_SECRET_HEADER]: deriveWhatsappWebhookSecret(API_KEY),
      },
    });
  });

  it("asks the Gateway to drop groups and anyone off the Allowlist before dispatch", async () => {
    const gateway = stubGateway();

    await ensureWhatsappWebhook();

    const [registration] = gateway.callsTo("/api/webhooks/register");
    expect(registration.body?.filters).toEqual({
      allowedChatIds: [ALLOWED_JID],
      ignoreGroups: true,
    });
  });

  it("leaves the Gateway with one webhook when Boop starts twice", async () => {
    const gateway = stubGateway();

    const first = await ensureWhatsappWebhook();
    const second = await ensureWhatsappWebhook();

    expect(first.status).toBe("registered");
    expect(second).toEqual({ status: "unchanged", url: EXPECTED_WEBHOOK_URL });
    expect(gateway.webhooks).toHaveLength(1);
    expect(gateway.callsTo("/api/webhooks/register")).toHaveLength(1);
    expect(gateway.callsTo("/api/webhooks/update")).toHaveLength(0);
  });

  it("updates the webhook in place, rather than adding one, when Boop's address has changed", async () => {
    const gateway = stubGateway();
    await ensureWhatsappWebhook();

    process.env.BOOP_TAILNET_ADDRESS = "100.101.102.6";
    const moved = await ensureWhatsappWebhook();

    expect(moved).toEqual({
      status: "updated",
      url: `http://100.101.102.6:${PORT}/whatsapp/webhook`,
    });
    expect(gateway.webhooks).toHaveLength(1);
    expect(gateway.webhooks[0]).toMatchObject({
      url: `http://100.101.102.6:${PORT}/whatsapp/webhook`,
    });
  });

  it("re-registers when the signing secret no longer matches the Gateway's", async () => {
    const gateway = stubGateway();
    await ensureWhatsappWebhook();

    // Rotating the API key rotates the derived secret, so the Gateway is now
    // holding a webhook that would be refused at the door.
    process.env.WHATSAPP_API_KEY = "rotated-gateway-key";
    const rotated = await ensureWhatsappWebhook();

    expect(rotated.status).toBe("updated");
    expect(gateway.webhooks).toHaveLength(1);
    expect(gateway.webhooks[0]).toMatchObject({
      headers: {
        [WHATSAPP_WEBHOOK_SECRET_HEADER]: deriveWhatsappWebhookSecret("rotated-gateway-key"),
      },
    });
  });

  it("makes no request at all when WhatsApp is unconfigured", async () => {
    delete process.env.WHATSAPP_GATEWAY_URL;
    delete process.env.WHATSAPP_API_KEY;
    const gateway = stubGateway();

    await expect(ensureWhatsappWebhook()).resolves.toEqual({ status: "skipped" });

    expect(gateway.fetchMock).not.toHaveBeenCalled();
  });

  it("survives a Gateway that is unreachable at startup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const result = await ensureWhatsappWebhook();

    expect(result.status).toBe("failed");
  });

  it("names an un-paired session in the log, since nothing else will", async () => {
    stubGateway({ state: "UNPAIRED" });

    await ensureWhatsappWebhook();

    const said = warnings.join("\n");
    expect(said).toContain("UNPAIRED");
    expect(said).toContain("NOT linked");
    expect(said).toMatch(/offline too long|linked-devices/);
  });
});
