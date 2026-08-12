import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitWhatsappSender,
  resolveWhatsappHandle,
  type HandleResolution,
} from "../server/openwa/handles.js";
import { loadWhatsappConfig } from "../server/openwa/config.js";

// Placeholder values only - this is a public repo. 555-01xx is the reserved
// fictional US range, and `.example` is a reserved domain.
const GATEWAY_URL = "http://gateway.example:8080";
const OWNER_DIGITS = ["1", "555", "000", "0101"].join("");
const OWNER_HANDLE = `+${OWNER_DIGITS}`;
const STRANGER_DIGITS = ["1", "555", "000", "0102"].join("");
const GROUP_JID = `${OWNER_DIGITS}-1445627445@g.us`;
const OWNER_LID = `${["2", "8000", "0000", "0000", "01"].join("")}@lid`;
const ECHOING_LID = `${["2", "8000", "0000", "0000", "02"].join("")}@lid`;
const UNKNOWN_LID = `${["2", "8000", "0000", "0000", "03"].join("")}@lid`;

const WHATSAPP_ENV = [
  "WHATSAPP_GATEWAY_URL",
  "WHATSAPP_API_KEY",
  "WHATSAPP_SESSION_ID",
  "WHATSAPP_ALLOWLIST",
  "WHATSAPP_SELF_ADDRESS",
] as const;

const originalEnv = new Map(WHATSAPP_ENV.map((key) => [key, process.env[key]]));

function configureWhatsapp(allowlist = OWNER_HANDLE): void {
  process.env.WHATSAPP_GATEWAY_URL = GATEWAY_URL;
  process.env.WHATSAPP_API_KEY = "test-gateway-key";
  process.env.WHATSAPP_SESSION_ID = "test-session";
  process.env.WHATSAPP_ALLOWLIST = allowlist;
}

/**
 * A gateway whose contact lookup knows `contacts` and 404s on anything else.
 * Keyed by the `contactId` query parameter, which is how OpenWA is addressed.
 */
function stubGateway(contacts: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const contactId = url.searchParams.get("contactId") ?? "";
    const contact = contacts[contactId];
    if (contact === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ success: true, data: contact }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  // Quiet by default: several cases below log loudly on purpose.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

/**
 * The widest input space in the feature, and the place a future WhatsApp
 * address-format change surfaces. Every row states whether resolving it is
 * allowed to cost a Gateway round trip: only a `@lid` may, because only the
 * Gateway knows the number behind one.
 */
const NORMALIZATION_CASES: Array<{
  name: string;
  address: string;
  expected: HandleResolution;
  usesGateway?: true;
}> = [
  {
    name: "a @c.us address",
    address: `${OWNER_DIGITS}@c.us`,
    expected: { ok: true, handle: OWNER_HANDLE },
  },
  {
    name: "a @c.us address carrying a multi-device suffix",
    address: `${OWNER_DIGITS}:12@c.us`,
    expected: { ok: true, handle: OWNER_HANDLE },
  },
  {
    name: "an @s.whatsapp.net address",
    address: `${OWNER_DIGITS}@s.whatsapp.net`,
    expected: { ok: true, handle: OWNER_HANDLE },
  },
  {
    name: "bare digits",
    address: OWNER_DIGITS,
    expected: { ok: true, handle: OWNER_HANDLE },
  },
  {
    name: "an address that is already E.164",
    address: OWNER_HANDLE,
    expected: { ok: true, handle: OWNER_HANDLE },
  },
  {
    name: "a number punctuated the way a human writes one",
    address: "+1 (555) 000-0101",
    expected: { ok: true, handle: OWNER_HANDLE },
  },
  {
    name: "a @g.us group",
    address: GROUP_JID,
    expected: { ok: false, reason: "group" },
  },
  {
    name: "a @g.us group with a community-style id",
    address: "120363000000000000@g.us",
    expected: { ok: false, reason: "group" },
  },
  {
    name: "a @lid the gateway can put a number to",
    address: OWNER_LID,
    expected: { ok: true, handle: OWNER_HANDLE },
    usesGateway: true,
  },
  {
    name: "a @lid the gateway answers with only the same @lid",
    address: ECHOING_LID,
    expected: { ok: false, reason: "unresolvable" },
    usesGateway: true,
  },
  {
    name: "a @lid the gateway does not know",
    address: UNKNOWN_LID,
    expected: { ok: false, reason: "unresolvable" },
    usesGateway: true,
  },
  {
    name: "a @c.us address whose user part is not a number",
    address: "abc@c.us",
    expected: { ok: false, reason: "unresolvable" },
  },
  {
    name: "an empty address",
    address: "",
    expected: { ok: false, reason: "unresolvable" },
  },
  {
    name: "an address with no suffix and no digits",
    address: "not-an-address",
    expected: { ok: false, reason: "unresolvable" },
  },
  {
    name: "a status broadcast",
    address: "status@broadcast",
    expected: { ok: false, reason: "unresolvable" },
  },
  {
    name: "a number too short to be E.164",
    address: "1234567@c.us",
    expected: { ok: false, reason: "unresolvable" },
  },
  {
    name: "a number too long to be E.164",
    address: "1234567890123456@c.us",
    expected: { ok: false, reason: "unresolvable" },
  },
  {
    name: "a national-format number with a leading zero",
    address: `0${OWNER_DIGITS}@c.us`,
    expected: { ok: false, reason: "unresolvable" },
  },
];

describe("resolveWhatsappHandle", () => {
  it.each(NORMALIZATION_CASES)("resolves $name", async ({ address, expected, usesGateway }) => {
    configureWhatsapp();
    const fetchMock = stubGateway({
      [OWNER_LID]: { id: { _serialized: `${OWNER_DIGITS}@c.us` } },
      // A gateway version that only knows the @lid back tells us nothing, and
      // chasing its answer would loop.
      [ECHOING_LID]: { id: { _serialized: ECHOING_LID } },
    });

    expect(await resolveWhatsappHandle(address)).toEqual(expected);
    expect(fetchMock.mock.calls.length).toBe(usesGateway ? 1 : 0);
  });

  it("logs loudly when an address cannot be resolved, without printing it", async () => {
    configureWhatsapp();
    stubGateway();
    const errors = vi.mocked(console.error);

    await resolveWhatsappHandle("abc@c.us");

    const logged = errors.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("DROPPED");
    expect(logged).toContain("<3 chars, non-numeric>@c.us");
    expect(logged).not.toContain("abc@c.us");
  });

  it("says nothing about a group, because being in one is ordinary", async () => {
    configureWhatsapp();
    stubGateway();

    expect(await resolveWhatsappHandle(GROUP_JID)).toEqual({ ok: false, reason: "group" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reads a phone-number field in preference to the id the gateway echoes", async () => {
    configureWhatsapp();
    stubGateway({ [OWNER_LID]: { id: { _serialized: OWNER_LID }, pn: `${OWNER_DIGITS}@c.us` } });

    expect(await resolveWhatsappHandle(OWNER_LID)).toEqual({ ok: true, handle: OWNER_HANDLE });
  });
});

describe("admitWhatsappSender", () => {
  const ENTRY_FORMS = [
    OWNER_HANDLE,
    `${OWNER_DIGITS}@c.us`,
    OWNER_DIGITS,
    "+1 (555) 000-0101",
  ];

  it.each(ENTRY_FORMS)("admits the same sender for an allowlist written as %s", async (entry) => {
    configureWhatsapp(entry);
    stubGateway();

    expect(await admitWhatsappSender(`${OWNER_DIGITS}@c.us`)).toEqual({
      ok: true,
      handle: OWNER_HANDLE,
    });
  });

  it("admits an allowlisted sender who arrives as a @lid", async () => {
    configureWhatsapp();
    stubGateway({ [OWNER_LID]: { id: { _serialized: `${OWNER_DIGITS}@c.us` } } });

    expect(await admitWhatsappSender(OWNER_LID)).toEqual({ ok: true, handle: OWNER_HANDLE });
  });

  it("refuses a sender who is not on the allowlist", async () => {
    configureWhatsapp();
    stubGateway();

    expect(await admitWhatsappSender(`${STRANGER_DIGITS}@c.us`)).toEqual({
      ok: false,
      reason: "not-allowlisted",
    });
  });

  it("refuses a group even when its id starts with an allowlisted number", async () => {
    configureWhatsapp();
    stubGateway();

    expect(await admitWhatsappSender(GROUP_JID)).toEqual({ ok: false, reason: "group" });
  });

  it("reads several allowlist entries separated by commas and newlines", async () => {
    configureWhatsapp(`${OWNER_HANDLE},\n  ${STRANGER_DIGITS}@c.us`);
    stubGateway();

    expect(await admitWhatsappSender(`${OWNER_DIGITS}@c.us`)).toMatchObject({ ok: true });
    expect(await admitWhatsappSender(`${STRANGER_DIGITS}@c.us`)).toMatchObject({ ok: true });
  });

  it("ignores an allowlist entry written as a group", async () => {
    configureWhatsapp(GROUP_JID);
    stubGateway();

    expect(await admitWhatsappSender(GROUP_JID)).toEqual({ ok: false, reason: "group" });
    expect(await admitWhatsappSender(`${OWNER_DIGITS}@c.us`)).toEqual({
      ok: false,
      reason: "not-allowlisted",
    });
  });

  it("admits nobody when the allowlist is empty", async () => {
    configureWhatsapp("");
    stubGateway();

    expect(await admitWhatsappSender(`${OWNER_DIGITS}@c.us`)).toEqual({
      ok: false,
      reason: "not-allowlisted",
    });
  });

  it("admits nobody when the gateway is unconfigured", async () => {
    stubGateway();

    expect(await admitWhatsappSender(`${OWNER_DIGITS}@c.us`)).toEqual({
      ok: false,
      reason: "not-allowlisted",
    });
  });
});

describe("loadWhatsappConfig", () => {
  it("normalizes the self-address override to a Handle whichever form it is written in", () => {
    configureWhatsapp();
    process.env.WHATSAPP_SELF_ADDRESS = `${OWNER_DIGITS}@c.us`;
    expect(loadWhatsappConfig()?.selfHandle).toBe(OWNER_HANDLE);

    process.env.WHATSAPP_SELF_ADDRESS = OWNER_HANDLE;
    expect(loadWhatsappConfig()?.selfHandle).toBe(OWNER_HANDLE);
  });

  it("reports an empty allowlist as a problem, since nothing inbound can be admitted", () => {
    configureWhatsapp("");
    expect(loadWhatsappConfig()?.problems.join("\n")).toContain("WHATSAPP_ALLOWLIST is empty");
  });

  it("is absent rather than broken when the gateway is unconfigured", () => {
    expect(loadWhatsappConfig()).toBeNull();
  });
});
