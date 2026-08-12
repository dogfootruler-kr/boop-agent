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
const LEAKED_PHONE = ["+", "1", "555", "555", "0102"].join("");
// The same number, written by the agent with markdown emphasis *inside* it.
// Every adapter's formatting removes or rewrites those markers, so this is the
// shape that puts the digits back together on the way to the Gateway.
const MARKED_UP_PHONE = ["+", "1", " 555 ", "**", "555", "**", " 0103"].join("");
const MARKED_UP_PHONE_AS_READ = ["+", "1", " 555 ", "555", " 0103"].join("");
const WHATSAPP_GATEWAY_URL = "http://gateway.example:8080";
// The Handle is E.164; the JID is what the adapter reconstructs to send.
const RECIPIENT_JID = `${RECIPIENT.slice(1)}@c.us`;

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

function configureWhatsapp(): void {
  process.env.WHATSAPP_GATEWAY_URL = WHATSAPP_GATEWAY_URL;
  process.env.WHATSAPP_API_KEY = "test-gateway-key";
  process.env.WHATSAPP_SESSION_ID = "test-session";
  process.env.WHATSAPP_ALLOWLIST = RECIPIENT;
}

function unconfigureWhatsapp(): void {
  delete process.env.WHATSAPP_GATEWAY_URL;
  delete process.env.WHATSAPP_API_KEY;
  delete process.env.WHATSAPP_SESSION_ID;
  delete process.env.WHATSAPP_ALLOWLIST;
}

beforeEach(() => {
  clearChannels();
  unconfigureWhatsapp();
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
    unconfigureWhatsapp();
    await loadChannels();

    expect(resolveChannel(`whatsapp:${RECIPIENT}`)).toBeNull();
  });

  it("resolves a whatsapp Conversation ID to the OpenWA adapter and its Handle", async () => {
    configureSendblue();
    configureWhatsapp();
    await loadChannels();

    const resolved = resolveChannel(`whatsapp:${RECIPIENT}`);

    expect(resolved?.channel.key).toBe("whatsapp");
    expect(resolved?.handle).toBe(RECIPIENT);
    // Adding a channel must not cost the one already there.
    expect(resolveChannel(`sms:${RECIPIENT}`)?.channel.key).toBe("sms");
  });

  it("registers no whatsapp channel when the OpenWA gateway is unconfigured", async () => {
    unconfigureSendblue();
    unconfigureWhatsapp();
    await loadChannels();

    expect(listChannels()).toEqual([]);
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

  it("strips markdown before delivering, since iMessage renders none", async () => {
    configureSendblue();
    await loadChannels();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const text = [
      "# Heading",
      "**bold** and *italic* and `code`",
      "```js",
      "const x = 1;",
      "```",
      "[a link](https://example.com)",
    ].join("\n");

    await sendToConversation(`sms:${RECIPIENT}`, text);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const { content } = JSON.parse(String(init.body)) as { content: string };
    expect(content).toBe(
      ["Heading", "bold and italic and code", "const x = 1;", "", "a link (https://example.com)"].join("\n"),
    );
    expect(content).not.toContain("**");
    expect(content).not.toContain("```");
    expect(content).not.toContain("# Heading");
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

  it("redacts a number whose digits only come back together once markdown is stripped", async () => {
    configureSendblue();
    await loadChannels();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendToConversation(`sms:${RECIPIENT}`, `Her number is ${MARKED_UP_PHONE}`);

    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)).content as string,
    );
    expect(bodies.join("\n")).toBe("Her number is [phone number hidden]");
    expect(bodies.join("\n")).not.toContain(MARKED_UP_PHONE_AS_READ);
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

describe("the whatsapp channel", () => {
  async function loadWithWhatsapp() {
    configureSendblue();
    configureWhatsapp();
    await loadChannels();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  type FetchCall = [string | URL | Request, RequestInit?];

  function urlOf(call: FetchCall): string {
    return String(call[0]);
  }

  function bodyOf(call: FetchCall): Record<string, unknown> {
    return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
  }

  it("sends to the reconstructed JID for the Handle in the Conversation ID", async () => {
    const fetchMock = await loadWithWhatsapp();

    const delivered = await sendToConversation(`whatsapp:${RECIPIENT}`, "on my way");

    expect(delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(urlOf(call)).toBe(`${WHATSAPP_GATEWAY_URL}/api/sendText`);
    expect((call[1]?.headers as Record<string, string>)["x-api-key"]).toBe("test-gateway-key");
    expect(bodyOf(call)).toEqual({
      to: RECIPIENT_JID,
      content: "on my way",
    });
  });

  it("redacts phone numbers from every part it delivers", async () => {
    const fetchMock = await loadWithWhatsapp();

    await sendToConversation(`whatsapp:${RECIPIENT}`, `Call **${LEAKED_PHONE}** now`);

    const contents = fetchMock.mock.calls.map((call) => bodyOf(call).content as string);
    expect(contents.join("\n")).toBe("Call *[phone number hidden]* now");
    expect(contents.join("\n")).not.toContain(LEAKED_PHONE);
  });

  it("redacts a number whose digits only come back together once markup is translated", async () => {
    const fetchMock = await loadWithWhatsapp();

    await sendToConversation(`whatsapp:${RECIPIENT}`, `Her number is ${MARKED_UP_PHONE}`);

    const contents = fetchMock.mock.calls.map((call) => bodyOf(call).content as string);
    expect(contents.join("\n")).toBe("Her number is [phone number hidden]");
    // What WhatsApp renders, rather than what was sent: emphasis markers are
    // invisible to the reader, so a number split by them is still a leak.
    expect(contents.join("\n").replace(/[*_~`]/g, "")).not.toContain(MARKED_UP_PHONE_AS_READ);
  });

  it("translates to WhatsApp markup and keeps code blocks intact", async () => {
    const fetchMock = await loadWithWhatsapp();

    const text = [
      "# Heading",
      "**bold** and *italic* and `code` and ~~gone~~",
      "```js",
      "const x = 1;",
      "```",
      "[a link](https://example.com)",
    ].join("\n");

    await sendToConversation(`whatsapp:${RECIPIENT}`, text);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodyOf(fetchMock.mock.calls[0]).content).toBe(
      [
        "*Heading*",
        "*bold* and _italic_ and `code` and ~gone~",
        "```",
        "const x = 1;",
        "```",
        "a link (https://example.com)",
      ].join("\n"),
    );
  });

  it("keeps a long reply in one message, unlike iMessage", async () => {
    const fetchMock = await loadWithWhatsapp();

    const line = "x".repeat(1000);
    await sendToConversation(`whatsapp:${RECIPIENT}`, Array(20).fill(line).join("\n"));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect((bodyOf(fetchMock.mock.calls[0]).content as string).length).toBeGreaterThan(2900);
  });

  it("still splits a reply past what WhatsApp itself accepts", async () => {
    const fetchMock = await loadWithWhatsapp();

    const line = "x".repeat(1000);
    await sendToConversation(`whatsapp:${RECIPIENT}`, Array(70).fill(line).join("\n"));

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchMock.mock.calls) {
      expect((bodyOf(call).content as string).length).toBeLessThanOrEqual(65_000);
    }
  });

  it("turns the typing indication on for the Handle and off again when stopped", async () => {
    const fetchMock = await loadWithWhatsapp();

    const stopTyping = startTypingForConversation(`whatsapp:${RECIPIENT}`);
    stopTyping();

    expect(fetchMock.mock.calls.length).toBe(2);
    for (const call of fetchMock.mock.calls) {
      expect(urlOf(call)).toBe(`${WHATSAPP_GATEWAY_URL}/api/simulateTyping`);
    }
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ to: RECIPIENT_JID, on: true });
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ to: RECIPIENT_JID, on: false });
  });
});
