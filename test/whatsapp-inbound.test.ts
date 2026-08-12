import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitInboundWhatsappMessage,
  type WhatsappAdmission,
} from "../server/openwa/inbound.js";
import {
  deriveWhatsappWebhookSecret,
  verifyWhatsappWebhookSecret,
} from "../server/openwa/webhook-auth.js";

// Placeholder values only - this is a public repo. 555-01xx is the reserved
// fictional US range, and `.example` is a reserved domain.
const GATEWAY_URL = "http://gateway.example:8080";
const API_KEY = "test-gateway-key";
const OWNER_DIGITS = ["1", "555", "000", "0101"].join("");
const OWNER_HANDLE = `+${OWNER_DIGITS}`;
const OWNER_JID = `${OWNER_DIGITS}@c.us`;
const STRANGER_JID = `${["1", "555", "000", "0102"].join("")}@c.us`;
const GROUP_JID = `${OWNER_DIGITS}-1445627445@g.us`;
const OWNER_LID = `${["2", "8000", "0000", "0000", "01"].join("")}@lid`;
const MESSAGE_ID = `false_${OWNER_JID}_ABC123`;
const SIGNATURE = deriveWhatsappWebhookSecret(API_KEY);

const WHATSAPP_ENV = [
  "WHATSAPP_GATEWAY_URL",
  "WHATSAPP_API_KEY",
  "WHATSAPP_SESSION_ID",
  "WHATSAPP_ALLOWLIST",
] as const;

const originalEnv = new Map(WHATSAPP_ENV.map((key) => [key, process.env[key]]));

function configureWhatsapp(allowlist = OWNER_HANDLE): void {
  process.env.WHATSAPP_GATEWAY_URL = GATEWAY_URL;
  process.env.WHATSAPP_API_KEY = API_KEY;
  process.env.WHATSAPP_SESSION_ID = "test-session";
  process.env.WHATSAPP_ALLOWLIST = allowlist;
}

/** A gateway whose contact lookup can put a number to `OWNER_LID` and nothing else. */
function stubGateway() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const contactId = new URL(String(input)).searchParams.get("contactId") ?? "";
    if (contactId !== OWNER_LID) return new Response("{}", { status: 404 });
    return new Response(
      JSON.stringify({ success: true, data: { id: { _serialized: OWNER_JID } } }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The envelope shape OpenWA delivers, with only the message varied per case. */
function envelope(message: Record<string, unknown>, event = "message.received") {
  return {
    webhookId: "00000000-0000-0000-0000-000000000000",
    sessionId: "test-session",
    event,
    payload: { message },
    timestamp: 1700000000123,
  };
}

function textMessage(overrides: Record<string, unknown> = {}) {
  return envelope({ from: OWNER_JID, id: MESSAGE_ID, body: "hello", ...overrides });
}

/** A call carrying the signing secret the gateway is registered with. */
function admitSigned(body: unknown) {
  return admitInboundWhatsappMessage({ signature: SIGNATURE, body });
}

/** A call carrying some other signing secret, or none. */
function admitWith(signature: string | undefined, body: unknown) {
  return admitInboundWhatsappMessage({ signature, body });
}

beforeEach(() => {
  // Quiet by default: several cases below log loudly on purpose.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  configureWhatsapp();
  stubGateway();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of WHATSAPP_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("admitInboundWhatsappMessage", () => {
  it("admits a signed message from an allowlisted sender", async () => {
    expect(await admitSigned(textMessage())).toEqual<WhatsappAdmission>({
      admitted: true,
      message: {
        handle: OWNER_HANDLE,
        conversationId: `whatsapp:${OWNER_HANDLE}`,
        externalMessageId: MESSAGE_ID,
        text: "hello",
      },
    });
  });

  it("admits an allowlisted sender who arrives as a @lid", async () => {
    expect(await admitSigned(textMessage({ from: OWNER_LID }))).toMatchObject({
      admitted: true,
      message: { handle: OWNER_HANDLE, conversationId: `whatsapp:${OWNER_HANDLE}` },
    });
  });

  it("takes the caption when a message carries one instead of a body", async () => {
    expect(await admitSigned(textMessage({ body: "", caption: "a caption" }))).toMatchObject({
      admitted: true,
      message: { text: "a caption" },
    });
  });

  it("admits a message the gateway sent no id for, so dedup is skipped rather than blocking", async () => {
    const admission = await admitSigned(textMessage({ id: undefined }));

    expect(admission).toMatchObject({ admitted: true });
    expect(admission.admitted && admission.message.externalMessageId).toBeUndefined();
  });

  // Each row supplies the valid signing secret unless it says otherwise, so a
  // row that drops does so for the reason it names and not for a stray header.
  const DROPS: Array<{
    name: string;
    body: unknown;
    signature?: string;
    unsigned?: true;
    reason: string;
  }> = [
    {
      name: "a call carrying no signing secret at all",
      body: textMessage(),
      unsigned: true,
      reason: "unsigned",
    },
    {
      name: "a call whose signing secret is not the registered one",
      body: textMessage(),
      signature: deriveWhatsappWebhookSecret("some-other-key"),
      reason: "bad-signature",
    },
    {
      name: "a signing secret of the wrong length",
      body: textMessage(),
      signature: "short",
      reason: "bad-signature",
    },
    {
      name: "a sender who is not on the allowlist",
      body: textMessage({ from: STRANGER_JID }),
      reason: "not-allowlisted",
    },
    {
      name: "a group message",
      body: textMessage({ from: GROUP_JID }),
      reason: "group",
    },
    {
      name: "a group message the gateway addressed from an allowlisted participant",
      body: textMessage({ isGroupMsg: true }),
      reason: "group",
    },
    {
      name: "a message whose chat is a group even though its sender is allowlisted",
      body: textMessage({ chatId: GROUP_JID }),
      reason: "group",
    },
    {
      name: "a sender whose address resolves to no phone number",
      body: textMessage({ from: "abc@c.us" }),
      reason: "unresolvable",
    },
    {
      name: "a @lid the gateway cannot put a number to",
      body: textMessage({ from: `${["2", "8000", "0000", "0000", "09"].join("")}@lid` }),
      reason: "unresolvable",
    },
    {
      name: "Boop's own message echoed back by the gateway",
      body: textMessage({ fromMe: true }),
      reason: "own-message",
    },
    {
      name: "an event that is not a message",
      body: envelope({ from: OWNER_JID }, "session.state.changed"),
      reason: "not-a-message",
    },
    {
      name: "an envelope with no event",
      body: { payload: { message: { from: OWNER_JID, body: "hello" } } },
      reason: "malformed",
    },
    {
      name: "a body that is not an object at all",
      body: "not-json-shaped",
      reason: "malformed",
    },
    {
      name: "a message event carrying no message",
      body: envelope(undefined as never),
      reason: "malformed",
    },
    {
      name: "a message with no sender",
      body: textMessage({ from: undefined }),
      reason: "malformed",
    },
    {
      name: "a message with neither text nor caption",
      body: textMessage({ body: "" }),
      reason: "empty",
    },
  ];

  it.each(DROPS)("drops $name", async ({ body, signature, unsigned, reason }) => {
    expect(await admitWith(unsigned ? undefined : (signature ?? SIGNATURE), body)).toEqual({
      admitted: false,
      reason,
    });
  });

  it("admits nobody when the gateway is unconfigured, whatever the call carries", async () => {
    delete process.env.WHATSAPP_GATEWAY_URL;
    delete process.env.WHATSAPP_API_KEY;

    expect(await admitSigned(textMessage())).toEqual({ admitted: false, reason: "bad-signature" });
  });

  it("does not reach the gateway for a call it cannot attribute", async () => {
    const fetchMock = stubGateway();

    expect(await admitWith(undefined, textMessage({ from: OWNER_LID }))).toEqual({
      admitted: false,
      reason: "unsigned",
    });
    expect(await admitWith("wrong-secret", textMessage({ from: OWNER_LID }))).toEqual({
      admitted: false,
      reason: "bad-signature",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("verifyWhatsappWebhookSecret", () => {
  it("accepts only the secret derived from the gateway API key", () => {
    expect(verifyWhatsappWebhookSecret(SIGNATURE, API_KEY)).toBe(true);
    expect(verifyWhatsappWebhookSecret(deriveWhatsappWebhookSecret("other"), API_KEY)).toBe(false);
    expect(verifyWhatsappWebhookSecret("wrong", API_KEY)).toBe(false);
    expect(verifyWhatsappWebhookSecret(undefined, API_KEY)).toBe(false);
    expect(verifyWhatsappWebhookSecret(SIGNATURE, "")).toBe(false);
  });

  it("reads the configured API key when none is passed", () => {
    expect(verifyWhatsappWebhookSecret(SIGNATURE)).toBe(true);

    delete process.env.WHATSAPP_API_KEY;
    expect(verifyWhatsappWebhookSecret(SIGNATURE)).toBe(false);
  });

  it("derives a secret that is not the API key itself", () => {
    expect(SIGNATURE).not.toContain(API_KEY);
    expect(SIGNATURE).toHaveLength(64);
  });
});
