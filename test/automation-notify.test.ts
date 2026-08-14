import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { tickAutomations } from "../server/automations.js";
import { clearChannels, loadChannels } from "../server/channels/registry.js";

const { convexQuery, convexMutation, spawnExecutionAgent } = vi.hoisted(() => ({
  convexQuery: vi.fn(async (..._args: unknown[]) => null as unknown),
  convexMutation: vi.fn(async (..._args: unknown[]) => undefined as unknown),
  spawnExecutionAgent: vi.fn(async (..._args: unknown[]) => ({
    agentId: "agent_test",
    status: "completed",
    result: "3 emails need a reply",
  })),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: { query: convexQuery, mutation: convexMutation },
}));

vi.mock("../server/execution-agent.js", () => ({ spawnExecutionAgent }));

const MANAGED_ENV = [
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

/** One automation that is due right now, notifying on `notifyConversationId`. */
function dueAutomation(notifyConversationId: string) {
  return {
    automationId: "auto_test",
    name: "morning summary",
    task: "summarize my inbox",
    integrations: [],
    schedule: "0 8 * * *",
    timezone: "UTC",
    conversationId: notifyConversationId,
    notifyConversationId,
    nextRunAt: Date.now() - 1000,
    enabled: true,
  };
}

function answerWith(notifyConversationId: string) {
  convexQuery.mockImplementation(async (ref: unknown) => {
    if (getFunctionName(ref as never) === "automations:list") {
      return [dueAutomation(notifyConversationId)];
    }
    return null;
  });
}

/** Every message recorded in Convex as having been sent by Boop. */
function recordedMessages(): Array<Record<string, unknown>> {
  return convexMutation.mock.calls
    .filter(([ref]) => getFunctionName(ref as never) === "messages:send")
    .map(([, args]) => args as Record<string, unknown>);
}

/** Resolves once the fire-and-forget run has finished writing its result. */
async function waitForRunToFinish(): Promise<void> {
  await vi.waitFor(() =>
    expect(
      convexMutation.mock.calls.some(([ref]) => getFunctionName(ref as never) === "automations:markRan"),
    ).toBe(true),
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  clearChannels();
  convexQuery.mockClear();
  convexMutation.mockClear();
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

describe("automation result delivery", () => {
  it("delivers the result on the Channel the automation's Conversation belongs to", async () => {
    configureSendblue();
    configureWhatsapp();
    await loadChannels();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    answerWith(`whatsapp:${OWNER}`);

    await tickAutomations();
    await waitForRunToFinish();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      `${WHATSAPP_GATEWAY_URL}/api/sendText`,
    );
    expect(recordedMessages()).toEqual([
      {
        conversationId: `whatsapp:${OWNER}`,
        role: "assistant",
        content: "[morning summary]\n\n3 emails need a reply",
      },
    ]);
  });

  it("records nothing when the result could not be delivered", async () => {
    // The Conversation's Channel is not registered, so nothing went out. A
    // stored assistant message would tell the debug dashboard otherwise.
    configureSendblue();
    await loadChannels();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    answerWith(`whatsapp:${OWNER}`);

    await tickAutomations();
    await waitForRunToFinish();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordedMessages()).toEqual([]);
  });
});
