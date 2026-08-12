/**
 * Telling the Gateway where to deliver inbound WhatsApp messages.
 *
 * Boop does not own the Gateway's lifecycle: OpenWA is configured, reachable,
 * and verified, never started, supervised, or restarted from here. What Boop
 * does own is the one fact only Boop knows - its own address on the tailnet -
 * so at startup it hands that address to the Gateway and checks that the
 * WhatsApp session behind it is actually linked.
 *
 * Idempotency, concretely. Boop asks the Gateway what is already registered
 * (`GET /api/webhooks/list`) and reconciles against the one webhook it owns,
 * keyed by a stable id of its own (`WEBHOOK_ID`). When what is registered
 * already matches, nothing is POSTed at all, so a restart is free. When it
 * differs - a new tailnet address, a rotated API key and therefore a rotated
 * signing secret, a changed Allowlist - the existing entry is updated in place
 * rather than a second one added. Only when the Gateway has never heard of it
 * is a webhook created.
 *
 * The fallback matters and is deliberately not the default. A Gateway build
 * with no list endpoint (it answers 404 or 405) leaves Boop registering blind;
 * it then POSTs the keyed registration and relies on the Gateway treating a
 * repeat of the same id as an update. That is strictly weaker - a build that
 * ignored the id would accumulate a webhook per restart - so the fallback says
 * so in the log rather than pretending the reconcile happened.
 *
 * Nothing here throws. An unreachable Gateway at startup is logged and
 * survived: Boop starts, iMessage is unaffected, and only WhatsApp is degraded.
 */
import { toWhatsappJid } from "./addresses.js";
import { loadWhatsappConfig, type WhatsappConfig } from "./config.js";
import { BOOP_TAILNET_ADDRESS_ENV, discoverSelfTailnetAddress } from "./tailnet.js";
import { deriveWhatsappWebhookSecret, WHATSAPP_WEBHOOK_SECRET_HEADER } from "./webhook-auth.js";

const REQUEST_TIMEOUT_MS = 15_000;

/** Boop's own inbound route, mounted in `server/index.ts`. */
const WEBHOOK_PATH = "/whatsapp/webhook";

/** Same default as `server/index.ts`, for when no port is passed in. */
const DEFAULT_PORT = 3456;

/**
 * The id Boop registers its webhook under.
 *
 * Constant rather than generated, and that is the whole idempotency story on
 * the write path: a restart addresses the same row instead of creating a
 * sibling. Boop is bound to exactly one Gateway session, so one id is enough.
 */
const WEBHOOK_ID = "boop-whatsapp";

/**
 * The only event Boop acts on.
 *
 * `session.state.changed` is deliberately not subscribed to: the inbound gate
 * drops every non-message event, so subscribing would add traffic that changes
 * nothing. Session state is read directly instead, below.
 */
const WEBHOOK_EVENTS = ["message.received"] as const;

/** States in which the Gateway is linked to WhatsApp and messages can arrive. */
const LINKED_STATES = new Set(["CONNECTED"]);

/** States that are normal for a few seconds after the Gateway starts. */
const TRANSIENT_STATES = new Set(["OPENING", "PAIRING", "UNLAUNCHED"]);

/** What startup registration did, for a caller that wants to say so. */
export type WhatsappWebhookRegistration =
  /** No Gateway configured. The `whatsapp` Channel is absent, not broken. */
  | { status: "skipped" }
  /** The Gateway already had exactly this webhook. Nothing was sent. */
  | { status: "unchanged"; url: string }
  /** The Gateway had no webhook of Boop's, so one was created. */
  | { status: "registered"; url: string }
  /** The Gateway had a stale one under the same id, updated in place. */
  | { status: "updated"; url: string }
  /** Unreachable, refused, or Boop could not work out its own address. */
  | { status: "failed"; reason: string };

/** The registration Boop wants the Gateway to be holding. */
interface DesiredWebhook {
  readonly id: string;
  readonly url: string;
  readonly events: string[];
  /** Static headers the Gateway attaches to every delivery. */
  readonly headers: Record<string, string>;
  readonly filters: WebhookFilters;
  /** Which session this webhook belongs to, when the operator named one. */
  readonly sessionId?: string;
}

/**
 * Gateway-side dispatch filters.
 *
 * These exist to save both sides the traffic of delivering messages Boop is
 * going to refuse anyway. They are NOT the security boundary:
 * `admitInboundWhatsappMessage` in `server/openwa/inbound.ts` checks the
 * Allowlist and rejects groups itself, on every call, and stays authoritative.
 * A security property must not depend on configuration living on another
 * machine that Boop neither starts nor supervises.
 */
interface WebhookFilters {
  /** Gateway-native addresses of the allowlisted Handles. */
  readonly allowedChatIds: string[];
  readonly ignoreGroups: boolean;
}

/** One webhook as the Gateway reports it. Only these fields are read. */
interface GatewayWebhook {
  readonly id?: string;
  readonly url: string;
  readonly events: string[];
  readonly headers: Record<string, string>;
  readonly filters?: { allowedChatIds?: string[]; ignoreGroups?: boolean };
}

/** OpenWA answers `{ success, data }`. */
interface GatewayEnvelope {
  success?: boolean;
  data?: unknown;
}

/**
 * Register Boop's inbound webhook with the Gateway, idempotently.
 *
 * Silent and side-effect free when WhatsApp is unconfigured: someone who only
 * uses iMessage should not learn from the logs that a WhatsApp channel exists.
 * Never rejects, so a caller can fire it and forget it.
 */
export async function ensureWhatsappWebhook(
  options: { port?: number; tailnetAddress?: string } = {},
): Promise<WhatsappWebhookRegistration> {
  const config = loadWhatsappConfig();
  if (!config) return { status: "skipped" };

  try {
    // First, because it is the diagnostic: a Gateway whose session has
    // un-paired accepts a registration happily and then delivers nothing.
    await logSessionState(config);

    const url = await selfWebhookUrl(options);
    return await reconcile(config, desiredWebhook(config, url));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The address the Gateway should deliver to.
 *
 * Discovery is the tailnet module's job and its failure message is written to
 * be read, so it is allowed to propagate up to the single catch above.
 */
async function selfWebhookUrl(
  options: { port?: number; tailnetAddress?: string },
): Promise<string> {
  const address = await discoverSelfTailnetAddress({
    override: options.tailnetAddress ?? process.env[BOOP_TAILNET_ADDRESS_ENV],
  });
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  // A tailnet address may be IPv6, which has to be bracketed in a URL.
  const host = address.includes(":") ? `[${address}]` : address;
  return `http://${host}:${port}${WEBHOOK_PATH}`;
}

function desiredWebhook(config: WhatsappConfig, url: string): DesiredWebhook {
  // The JID is reconstructed here, at the Gateway boundary, and is not stored:
  // the Allowlist itself holds Handles. Sorted so that two runs that mean the
  // same thing compare equal and no pointless update is sent.
  const allowedChatIds = [...config.allowlist]
    .map((handle) => toWhatsappJid(handle))
    .filter((jid): jid is string => jid !== null)
    .sort();

  return {
    id: WEBHOOK_ID,
    url,
    events: [...WEBHOOK_EVENTS],
    // The secret is derived from the API key, never chosen and never stored.
    // Registering it and verifying it recompute the same value, so rotating
    // the API key rotates this and the next startup updates the Gateway.
    headers: { [WHATSAPP_WEBHOOK_SECRET_HEADER]: deriveWhatsappWebhookSecret(config.apiKey) },
    filters: { allowedChatIds, ignoreGroups: true },
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
  };
}

async function reconcile(
  config: WhatsappConfig,
  desired: DesiredWebhook,
): Promise<WhatsappWebhookRegistration> {
  const listed = await listWebhooks(config);

  if (!listed.ok) {
    if (!listed.unsupported) {
      return fail(`the gateway would not say what is registered (${listed.reason})`);
    }
    console.warn(
      "[whatsapp] this gateway has no webhook list endpoint, so registration cannot be " +
        `reconciled - POSTing it keyed as "${WEBHOOK_ID}" and relying on the gateway to treat ` +
        "a repeat of that id as an update. If webhooks pile up across restarts, that is " +
        "where to look.",
    );
    return (
      (await register(config, desired, "register")) ??
      fail("the gateway refused the registration")
    );
  }

  const mine = listed.webhooks.filter((w) => w.id === desired.id || w.url === desired.url);
  if (mine.length > 1) {
    console.warn(
      `[whatsapp] the gateway holds ${mine.length} webhooks pointing at Boop - every message ` +
        "will be delivered more than once. Inbound dedup absorbs that, but the extra ones were " +
        "not registered by this startup path and Boop will not remove them for you.",
    );
  }

  const current = mine[0];
  if (current && matchesDesired(current, desired)) {
    console.log(`[whatsapp] the gateway already delivers to ${desired.url} - nothing to register`);
    return { status: "unchanged", url: desired.url };
  }

  if (current) {
    // Updated under the id the gateway itself reports, so an entry that was
    // matched by URL rather than by id is corrected rather than duplicated.
    const updated: DesiredWebhook = { ...desired, id: current.id ?? desired.id };
    return (await register(config, updated, "update")) ?? fail("the gateway refused the update");
  }

  return (
    (await register(config, desired, "register")) ??
    fail("the gateway refused the registration")
  );
}

/**
 * Create or update the webhook. Returns null when the Gateway refused it.
 */
async function register(
  config: WhatsappConfig,
  webhook: DesiredWebhook,
  mode: "register" | "update",
): Promise<WhatsappWebhookRegistration | null> {
  const res = await postJson(config, `/api/webhooks/${mode}`, webhook);
  if (!res) return null;
  if (!res.ok) {
    console.error(`[whatsapp] webhook ${mode} failed ${res.status}`);
    const hint = hintForStatus(res.status);
    if (hint) console.error(`[whatsapp] → ${hint}`);
    return null;
  }
  const envelope = (await res.json().catch(() => null)) as GatewayEnvelope | null;
  if (envelope?.success === false) {
    console.error(`[whatsapp] the gateway took the webhook ${mode} but reported it as failed`);
    return null;
  }

  if (mode === "update") {
    console.log(`[whatsapp] pointed the gateway's existing webhook at ${webhook.url}`);
    return { status: "updated", url: webhook.url };
  }
  console.log(
    `[whatsapp] registered ${webhook.url} with the gateway for ${webhook.events.join(", ")}`,
  );
  return { status: "registered", url: webhook.url };
}

type ListResult =
  | { ok: true; webhooks: GatewayWebhook[] }
  | { ok: false; unsupported: boolean; reason: string };

async function listWebhooks(config: WhatsappConfig): Promise<ListResult> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/api/webhooks/list`, {
      method: "GET",
      headers: { "x-api-key": config.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, unsupported: false, reason: `unreachable: ${String(err)}` };
  }
  // 404 and 405 are how a build without this endpoint answers; anything else
  // is a Gateway that has the endpoint and refused, which is a real failure.
  if (res.status === 404 || res.status === 405) {
    return { ok: false, unsupported: true, reason: `status ${res.status}` };
  }
  if (!res.ok) {
    const hint = hintForStatus(res.status);
    const reason = hint ? `status ${res.status}: ${hint}` : `status ${res.status}`;
    return { ok: false, unsupported: false, reason };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, unsupported: false, reason: "the gateway's webhook list was not JSON" };
  }
  return { ok: true, webhooks: readWebhooks(body) };
}

/**
 * Whether the Gateway is already holding exactly what Boop wants.
 *
 * A Gateway that does not echo the signing-secret header back - redacting a
 * secret is a reasonable thing for it to do - will never compare equal, so
 * Boop will re-send the same registration on every startup. That is noisier
 * than necessary and still idempotent, which is the right way round: the
 * alternative is assuming a secret matches and going quietly deaf when it does
 * not.
 */
function matchesDesired(existing: GatewayWebhook, desired: DesiredWebhook): boolean {
  if (existing.url !== desired.url) return false;
  if (!sameSet(existing.events, desired.events)) return false;

  const secret = headerValue(existing.headers, WHATSAPP_WEBHOOK_SECRET_HEADER);
  if (secret !== desired.headers[WHATSAPP_WEBHOOK_SECRET_HEADER]) return false;

  if (existing.filters?.ignoreGroups !== desired.filters.ignoreGroups) return false;
  return sameSet(existing.filters?.allowedChatIds ?? [], desired.filters.allowedChatIds);
}

/**
 * Say out loud whether the Gateway is still linked to WhatsApp.
 *
 * This is the only place an un-paired session becomes visible. There is no
 * dashboard surface for it by design, and the failure is silent from every
 * other angle: the Gateway answers, registration succeeds, Boop looks healthy,
 * and no message ever arrives. So the log has to carry the diagnosis and not
 * just the symptom.
 */
async function logSessionState(config: WhatsappConfig): Promise<void> {
  const session = config.sessionId ?? "(unnamed - WHATSAPP_SESSION_ID is not set)";
  const state = await readSessionState(config);

  if (!state) {
    console.warn(`[whatsapp] session ${session}: the gateway reported no connection state`);
    console.warn(
      "[whatsapp] → Boop cannot tell whether WhatsApp is still linked. If messages stop " +
        "arriving with nothing else in these logs, that is the first thing to check.",
    );
    return;
  }

  const normalized = state.toUpperCase();
  if (LINKED_STATES.has(normalized)) {
    console.log(`[whatsapp] session ${session} is ${state} - the gateway is linked to WhatsApp`);
    return;
  }
  if (TRANSIENT_STATES.has(normalized)) {
    console.warn(
      `[whatsapp] session ${session} is ${state} - the gateway is still coming up, so inbound ` +
        "messages will not arrive until it reaches CONNECTED. If it stays here, it is " +
        "not coming up.",
    );
    return;
  }

  console.warn(`[whatsapp] session ${session} is ${state} - the gateway is NOT linked to WhatsApp`);
  console.warn(
    "[whatsapp] → no inbound WhatsApp message can arrive in this state, and nothing else " +
      "will say so: Boop stays healthy, replies on iMessage, and simply goes quiet on WhatsApp.",
  );
  console.warn(
    "[whatsapp] → a session un-pairs on its own when the linked phone stays offline too long, " +
      "or when the device is removed from WhatsApp's linked-devices screen.",
  );
  console.warn(
    "[whatsapp] → fix it where the gateway runs, by scanning its QR code again. Boop never " +
      "starts, supervises, or restarts the gateway.",
  );
}

/** The Gateway's own name for its connection state, or null if it said nothing usable. */
async function readSessionState(config: WhatsappConfig): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/api/session/getConnectionState`, {
      method: "GET",
      headers: { "x-api-key": config.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[whatsapp] could not read the gateway's session state: ${String(err)}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`[whatsapp] could not read the gateway's session state (status ${res.status})`);
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const data = (body as GatewayEnvelope)?.data ?? body;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (isRecord(data)) {
    // The field has moved between Gateway versions, so every plausible one is
    // read rather than one being trusted.
    for (const key of ["state", "connectionState", "status"]) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function fail(reason: string): WhatsappWebhookRegistration {
  console.error(`[whatsapp] webhook registration failed: ${reason}`);
  console.error(
    "[whatsapp] → Boop is running and iMessage is unaffected, but no WhatsApp message will " +
      "arrive until the gateway is reachable and Boop has been restarted.",
  );
  return { status: "failed", reason };
}

async function postJson(
  config: WhatsappConfig,
  path: string,
  body: unknown,
): Promise<Response | null> {
  try {
    return await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[whatsapp] ${path} unreachable: ${String(err)}`);
    return null;
  }
}

function readWebhooks(body: unknown): GatewayWebhook[] {
  const data = (body as GatewayEnvelope)?.data ?? body;
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.webhooks)
      ? data.webhooks
      : [];
  return rows.map(readWebhook).filter((w): w is GatewayWebhook => w !== null);
}

function readWebhook(value: unknown): GatewayWebhook | null {
  if (!isRecord(value)) return null;
  const url = value.url;
  if (typeof url !== "string" || !url) return null;
  const filters = isRecord(value.filters) ? value.filters : undefined;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    url,
    events: stringList(value.events),
    headers: stringRecord(value.headers),
    filters: filters
      ? {
          allowedChatIds: stringList(filters.allowedChatIds),
          ignoreGroups: filters.ignoreGroups === true,
        }
      : undefined,
  };
}

/** Header names are case-insensitive, and a Gateway may echo them any way it likes. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hintForStatus(status: number): string | null {
  if (status === 401 || status === 403) return "WHATSAPP_API_KEY was rejected by the gateway.";
  if (status === 400 || status === 422) {
    return (
      "The gateway rejected the webhook definition. " +
      "A session that has un-paired reports this way too."
    );
  }
  if (status >= 500) return "The gateway itself errored. Check that it is running.";
  return null;
}
