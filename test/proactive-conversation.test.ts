import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { deliverAssistantMessage } from "../server/channels/delivery.js";
import { proactiveConversationId } from "../server/channels/proactive.js";
import { clearChannels, loadChannels } from "../server/channels/registry.js";

const { convexMutation } = vi.hoisted(() => ({
  convexMutation: vi.fn(async (..._args: unknown[]) => undefined as unknown),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: { query: vi.fn(), mutation: convexMutation },
}));

const MANAGED_ENV = [
  "BOOP_USER_PHONE",
  "BOOP_PROACTIVE_CHANNEL",
  "SENDBLUE_API_KEY",
  "SENDBLUE_API_SECRET",
  "SENDBLUE_FROM_NUMBER",
  "WHATSAPP_GATEWAY_URL",
  "WHATSAPP_API_KEY",
  "WHATSAPP_SESSION_ID",
  "WHATSAPP_ALLOWLIST",
] as const;

const originalEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));

// Placeholder numbers and hosts only - this is a public repo.
const FROM_NUMBER = ["+", "1", "555", "000", "0100"].join("");
const OWNER = ["+", "1", "555", "000", "0101"].join("");
const OWNER_LOCAL_DIGITS = ["555", "000", "0101"].join("");
const OWNER_JID = `${OWNER.slice(1)}@c.us`;
const WHATSAPP_GATEWAY_URL = "http://gateway.example:8080";

function configureSendblue(): void {
  process.env.SENDBLUE_API_KEY = "test-key";
  process.env.SENDBLUE_API_SECRET = "test-secret";
  process.env.SENDBLUE_FROM_NUMBER = FROM_NUMBER;
}

function configureWhatsapp(): void {
  process.env.WHATSAPP_GATEWAY_URL = WHATSAPP_GATEWAY_URL;
  process.env.WHATSAPP_API_KEY = "test-gateway-key";
  process.env.WHATSAPP_SESSION_ID = "test-session";
  process.env.WHATSAPP_ALLOWLIST = OWNER;
}

function stubFetch() {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function recordedMessages(): Array<Record<string, unknown>> {
  return convexMutation.mock.calls
    .filter(([ref]) => getFunctionName(ref as never) === "messages:send")
    .map(([, args]) => args as Record<string, unknown>);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  clearChannels();
  convexMutation.mockClear();
  for (const key of MANAGED_ENV) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearChannels();
  for (const key of MANAGED_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the proactive Conversation", () => {
  it("is on the sms channel when no channel is configured", () => {
    process.env.BOOP_USER_PHONE = OWNER;

    expect(proactiveConversationId()).toBe(`sms:${OWNER}`);
  });

  it("is on the configured channel", () => {
    process.env.BOOP_USER_PHONE = OWNER;
    process.env.BOOP_PROACTIVE_CHANNEL = "whatsapp";

    expect(proactiveConversationId()).toBe(`whatsapp:${OWNER}`);
  });

  it("normalizes the configured number to a Handle, on any channel", () => {
    process.env.BOOP_USER_PHONE = OWNER_LOCAL_DIGITS;
    expect(proactiveConversationId()).toBe(`sms:${OWNER}`);

    process.env.BOOP_PROACTIVE_CHANNEL = "whatsapp";
    expect(proactiveConversationId()).toBe(`whatsapp:${OWNER}`);
  });

  it("is nowhere when the number is missing or unusable", () => {
    expect(proactiveConversationId()).toBeNull();

    process.env.BOOP_USER_PHONE = "not a number";
    expect(proactiveConversationId()).toBeNull();
  });

  it("is nowhere when the configured channel is not one Boop has", () => {
    // Not a fallback to iMessage: delivering urgent mail to a channel the
    // user is not watching is the failure this configuration exists to avoid.
    process.env.BOOP_USER_PHONE = OWNER;
    process.env.BOOP_PROACTIVE_CHANNEL = "carrier-pigeon";

    expect(proactiveConversationId()).toBeNull();
  });

  it("takes a Telegram chat ID verbatim rather than normalizing it to E.164", () => {
    // The one Channel whose Handle is not a phone number. Normalizing here
    // would produce a Conversation ID matching nothing inbound and a send
    // Telegram answers with "chat not found".
    process.env.BOOP_PROACTIVE_CHANNEL = "telegram";
    process.env.BOOP_USER_PHONE = "111222333";
    expect(proactiveConversationId()).toBe("telegram:111222333");
  });

  it("is nowhere when the telegram handle was written as a phone number", () => {
    process.env.BOOP_PROACTIVE_CHANNEL = "telegram";
    process.env.BOOP_USER_PHONE = OWNER;
    expect(proactiveConversationId()).toBeNull();
  });

  it("delivers to the gateway of the configured channel", async () => {
    process.env.BOOP_USER_PHONE = OWNER;
    process.env.BOOP_PROACTIVE_CHANNEL = "whatsapp";
    configureSendblue();
    configureWhatsapp();
    await loadChannels();
    const fetchMock = stubFetch();

    await deliverAssistantMessage(proactiveConversationId()!, "your landlord replied");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${WHATSAPP_GATEWAY_URL}/api/sendText`);
    expect(JSON.parse(String(init?.body))).toEqual({
      to: OWNER_JID,
      content: "your landlord replied",
    });
  });

  it("delivers to iMessage for someone who configured nothing new", async () => {
    process.env.BOOP_USER_PHONE = OWNER;
    configureSendblue();
    configureWhatsapp();
    await loadChannels();
    const fetchMock = stubFetch();

    await deliverAssistantMessage(proactiveConversationId()!, "your landlord replied");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.sendblue.com/api/send-message");
  });
});

describe("deliverAssistantMessage", () => {
  it("records what it delivered", async () => {
    configureSendblue();
    await loadChannels();
    stubFetch();

    const delivered = await deliverAssistantMessage(`sms:${OWNER}`, "on my way");

    expect(delivered).toBe(true);
    expect(recordedMessages()).toEqual([
      { conversationId: `sms:${OWNER}`, role: "assistant", content: "on my way" },
    ]);
  });

  it("records nothing when the Conversation has no Channel to deliver on", async () => {
    // Whatsapp is unconfigured, so the message reached nobody. Storing it
    // would show the user a message on the dashboard they never received.
    configureSendblue();
    await loadChannels();
    const fetchMock = stubFetch();

    const delivered = await deliverAssistantMessage(`whatsapp:${OWNER}`, "on my way");

    expect(delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordedMessages()).toEqual([]);
  });
});
