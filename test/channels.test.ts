import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearChannels,
  listChannels,
  loadChannels,
  parseConversationId,
  resolveChannel,
} from "../server/channels/registry.js";
import {
  sendToConversation,
  startTypingForConversation,
} from "../server/channels/outbound.js";

const SENDBLUE_ENV = [
  "SENDBLUE_API_KEY",
  "SENDBLUE_API_SECRET",
  "SENDBLUE_FROM_NUMBER",
] as const;

const originalEnv = new Map(SENDBLUE_ENV.map((key) => [key, process.env[key]]));

// Placeholder numbers only - this is a public repo.
const FROM_NUMBER = ["+", "1", "555", "000", "0100"].join("");
const RECIPIENT = ["+", "1", "555", "000", "0101"].join("");
const LEAKED_PHONE = ["+", "1", "555", "555", "0102"].join("");

function configureSendblue(): void {
  process.env.SENDBLUE_API_KEY = "test-key";
  process.env.SENDBLUE_API_SECRET = "test-secret";
  process.env.SENDBLUE_FROM_NUMBER = FROM_NUMBER;
}

function unconfigureSendblue(): void {
  delete process.env.SENDBLUE_API_KEY;
  delete process.env.SENDBLUE_API_SECRET;
  delete process.env.SENDBLUE_FROM_NUMBER;
}

beforeEach(() => {
  clearChannels();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearChannels();
  for (const key of SENDBLUE_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("channel registry", () => {
  it("resolves an sms Conversation ID to the Sendblue adapter and its Handle", async () => {
    configureSendblue();
    await loadChannels();

    const resolved = resolveChannel(`sms:${RECIPIENT}`);

    expect(resolved?.channel.key).toBe("sms");
    expect(resolved?.handle).toBe(RECIPIENT);
  });

  it("resolves an unconfigured channel to nothing", async () => {
    configureSendblue();
    await loadChannels();

    expect(resolveChannel(`whatsapp:${RECIPIENT}`)).toBeNull();
  });

  it("registers no sms channel when the Sendblue gateway is unconfigured", async () => {
    unconfigureSendblue();
    await loadChannels();

    expect(listChannels()).toEqual([]);
    expect(resolveChannel(`sms:${RECIPIENT}`)).toBeNull();
  });

  it("resolves a Conversation ID with no channel prefix to nothing", async () => {
    configureSendblue();
    await loadChannels();

    expect(resolveChannel(`chat:${RECIPIENT}`)).toBeNull();
    expect(resolveChannel("no-colon-here")).toBeNull();
    expect(resolveChannel("sms:")).toBeNull();
  });

  it("splits a Conversation ID on its first colon so a Handle may contain one", () => {
    expect(parseConversationId(`sms:${RECIPIENT}`)).toEqual({
      channelKey: "sms",
      handle: RECIPIENT,
    });
    expect(parseConversationId("whatsapp:a:b")).toEqual({
      channelKey: "whatsapp",
      handle: "a:b",
    });
    expect(parseConversationId(":handle")).toBeNull();
  });
});

describe("sendToConversation", () => {
  it("sends to the Handle from the Conversation ID through the resolved channel", async () => {
    configureSendblue();
    await loadChannels();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const delivered = await sendToConversation(`sms:${RECIPIENT}`, "on my way");

    expect(delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sendblue.com/api/send-message");
    expect(JSON.parse(String(init.body))).toMatchObject({
      number: RECIPIENT,
      content: "on my way",
      from_number: FROM_NUMBER,
    });
  });

  it("redacts phone numbers from every part it delivers", async () => {
    configureSendblue();
    await loadChannels();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendToConversation(`sms:${RECIPIENT}`, `Call **${LEAKED_PHONE}** now`);

    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)).content as string,
    );
    expect(bodies.join("\n")).toBe("Call [phone number hidden] now");
    expect(bodies.join("\n")).not.toContain(LEAKED_PHONE);
  });

  it("splits a long reply into parts the gateway accepts", async () => {
    configureSendblue();
    await loadChannels();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const line = "x".repeat(1000);
    await sendToConversation(`sms:${RECIPIENT}`, [line, line, line, line].join("\n"));

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetchMock.mock.calls) {
      const { content } = JSON.parse(String((init as RequestInit).body)) as { content: string };
      expect(content.length).toBeLessThanOrEqual(2900);
    }
  });

  it("shows a typing indication to the Handle from the Conversation ID", async () => {
    configureSendblue();
    await loadChannels();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const stopTyping = startTypingForConversation(`sms:${RECIPIENT}`);
    stopTyping();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sendblue.com/api/send-typing-indicator");
    expect(JSON.parse(String(init.body))).toMatchObject({ number: RECIPIENT });
  });

  it("sends nothing when the conversation has no channel", async () => {
    configureSendblue();
    await loadChannels();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const delivered = await sendToConversation(`whatsapp:${RECIPIENT}`, "hello");

    expect(delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
