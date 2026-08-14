import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  matchesLinkedInDemoPrompt,
  matchesWaterBottleDemoPrompt,
  maybeHandleScriptedDemoReply,
} from "../server/scripted-demo-replies.js";
import { clearChannels, loadChannels } from "../server/channels/registry.js";

const { convexQuery, convexMutation } = vi.hoisted(() => ({
  convexQuery: vi.fn(async (..._args: unknown[]) => "true"),
  convexMutation: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: {
    query: convexQuery,
    mutation: convexMutation,
  },
}));

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
const RECIPIENT = ["+", "1", "555", "000", "0101"].join("");
const WHATSAPP_GATEWAY_URL = "http://gateway.example:8080";
const RECIPIENT_JID = `${RECIPIENT.slice(1)}@c.us`;
const WATER_BOTTLE_PROMPT = "what was that water bottle brand my mom texted me about";

function configureSendblue(): void {
  process.env.SENDBLUE_API_KEY = "test-key";
  process.env.SENDBLUE_API_SECRET = "test-secret";
  process.env.SENDBLUE_FROM_NUMBER = FROM_NUMBER;
}

function configureWhatsapp(): void {
  process.env.WHATSAPP_GATEWAY_URL = WHATSAPP_GATEWAY_URL;
  process.env.WHATSAPP_API_KEY = "test-gateway-key";
  process.env.WHATSAPP_SESSION_ID = "test-session";
  process.env.WHATSAPP_ALLOWLIST = RECIPIENT;
}

function stubFetch() {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function urlsCalled(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

beforeEach(() => {
  clearChannels();
  convexQuery.mockClear();
  convexMutation.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearChannels();
  for (const key of MANAGED_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("scripted demo replies", () => {
  it("matches the private water-bottle demo prompt with normal texting punctuation", () => {
    expect(
      matchesWaterBottleDemoPrompt("What was that water bottle brand my mom texted me about?"),
    ).toBe(true);
    expect(
      matchesWaterBottleDemoPrompt(
        "  what   was that water bottle brand my mom texted me about!!! ",
      ),
    ).toBe(true);
  });

  it("does not intercept unrelated messages", () => {
    expect(matchesWaterBottleDemoPrompt("what water bottle should I buy?")).toBe(false);
    expect(matchesWaterBottleDemoPrompt("what did my mom text me about?")).toBe(false);
  });

  it("matches natural LinkedIn browser demo prompts", () => {
    expect(matchesLinkedInDemoPrompt("Check my LinkedIn")).toBe(true);
    expect(matchesLinkedInDemoPrompt("Check my LinkedIn messages using the browser.")).toBe(true);
    expect(matchesLinkedInDemoPrompt("Can you use the browser to check my LinkedIn messages?")).toBe(
      true,
    );
  });

  it("does not intercept unrelated LinkedIn messages", () => {
    expect(matchesLinkedInDemoPrompt("Write a LinkedIn post for me")).toBe(false);
    expect(matchesLinkedInDemoPrompt("Who messaged me?")).toBe(false);
  });
});

describe("maybeHandleScriptedDemoReply", () => {
  it("routes a demo run on an sms Conversation ID to the Sendblue adapter", async () => {
    configureSendblue();
    await loadChannels();
    const fetchMock = stubFetch();

    const handled = await maybeHandleScriptedDemoReply({
      conversationId: `sms:${RECIPIENT}`,
      content: WATER_BOTTLE_PROMPT,
      turnTag: "test",
    });

    expect(handled).toBe(true);
    const urls = urlsCalled(fetchMock);
    expect(urls.some((url) => url.includes("api.sendblue.com"))).toBe(true);
    expect(urls.some((url) => url.startsWith(WHATSAPP_GATEWAY_URL))).toBe(false);
  });

  it("routes a demo run on a whatsapp Conversation ID to the WhatsApp adapter", async () => {
    configureSendblue();
    configureWhatsapp();
    await loadChannels();
    const fetchMock = stubFetch();

    const handled = await maybeHandleScriptedDemoReply({
      conversationId: `whatsapp:${RECIPIENT}`,
      content: WATER_BOTTLE_PROMPT,
      turnTag: "test",
    });

    expect(handled).toBe(true);
    const urls = urlsCalled(fetchMock);
    expect(urls.some((url) => url.startsWith(WHATSAPP_GATEWAY_URL))).toBe(true);
    expect(urls.some((url) => url.includes("api.sendblue.com"))).toBe(false);
  });

  it("keeps the WhatsApp typing indication on for the scripted pause, instead of flickering off immediately", async () => {
    configureSendblue();
    configureWhatsapp();
    await loadChannels();
    const fetchMock = stubFetch();
    vi.useFakeTimers();

    const typingBodies = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).startsWith(`${WHATSAPP_GATEWAY_URL}/api/simulateTyping`))
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

    const handled = maybeHandleScriptedDemoReply({
      conversationId: `whatsapp:${RECIPIENT}`,
      content: WATER_BOTTLE_PROMPT,
      turnTag: "test",
    });

    // Let the synchronous setup run: typing must already be on, and the
    // scripted pause has not elapsed yet, so it must not have been turned
    // off again this fast.
    await vi.advanceTimersByTimeAsync(0);
    expect(typingBodies()).toContainEqual({ to: RECIPIENT_JID, on: true });
    expect(typingBodies()).not.toContainEqual({ to: RECIPIENT_JID, on: false });

    // Once the scripted pause (150ms) has elapsed, typing turns off again.
    await vi.advanceTimersByTimeAsync(150);
    expect(typingBodies()).toContainEqual({ to: RECIPIENT_JID, on: false });

    await vi.advanceTimersByTimeAsync(2000);
    await handled;
    vi.useRealTimers();
  });

  it("does not intercept a non-demo message on either channel", async () => {
    configureSendblue();
    configureWhatsapp();
    await loadChannels();
    const fetchMock = stubFetch();

    const handled = await maybeHandleScriptedDemoReply({
      conversationId: `whatsapp:${RECIPIENT}`,
      content: "what's the weather tomorrow",
      turnTag: "test",
    });

    expect(handled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
