/**
 * The inbound admission gate for the `whatsapp` Channel.
 *
 * This is the security boundary of the Channel. It is a plain function taking
 * a webhook call and returning accept-or-drop with a reason, rather than logic
 * living inside a request handler, so that its behaviour is exercisable
 * without standing up a server. `server/openwa/webhook.ts` does nothing but
 * act on what this returns.
 *
 * The order below is load-bearing and is recorded in
 * `docs/adr/0002-inbound-trust-boundary.md`: signature verification, then
 * sender resolution to a Handle, then the Allowlist check. Everything a
 * message can cost Boop - a Convex write, a dedup row, an agent turn carrying
 * the user's memory and every connected integration - happens in the handler,
 * strictly after this function has said yes.
 *
 * Note that the per-function test style cannot assert that ordering, only the
 * decision. That gap is accepted deliberately; the ordering is a code-review
 * property, which is why this file is short enough to read top to bottom.
 */
import { admitWhatsappSender } from "./handles.js";
import { parseWhatsappAddress } from "./addresses.js";
import { verifyWhatsappWebhookSecret } from "./webhook-auth.js";

/** The one Gateway event Boop acts on. Everything else is ignored. */
const MESSAGE_EVENT = "message.received";

/** Why a message did not become an agent turn. */
export type WhatsappDropReason =
  /** No signing secret on the request at all. */
  | "unsigned"
  /** A signing secret that is not the one Boop registered. */
  | "bad-signature"
  /** Not the envelope shape this Gateway version is supposed to send. */
  | "malformed"
  /** A Gateway event Boop does not act on, such as a session state change. */
  | "not-a-message"
  /** Boop's own outbound message, echoed back by the Gateway. */
  | "own-message"
  /** A group. Being added to one must not turn every message in it into a turn. */
  | "group"
  /** No Handle could be recovered from the sender's address. */
  | "unresolvable"
  /** A resolved Handle that is not on the Allowlist. */
  | "not-allowlisted"
  /** Nothing to answer: no text and, for now, no supported media. */
  | "empty";

/** An inbound message that has passed every gate and may now cost something. */
export interface AdmittedWhatsappMessage {
  /** The sender, as E.164. */
  readonly handle: string;
  /** `whatsapp:<handle>`, the routing key for the reply. */
  readonly conversationId: string;
  /** The Gateway's own message id, for the dedup claim. Absent on some events. */
  readonly externalMessageId?: string;
  /** The message text, or its caption when it carried one. */
  readonly text: string;
}

export type WhatsappAdmission =
  | { admitted: true; message: AdmittedWhatsappMessage }
  | { admitted: false; reason: WhatsappDropReason };

/** One webhook call, reduced to the two things admission depends on. */
export interface InboundWhatsappCall {
  /** The signing-secret header, or undefined when the call carried none. */
  readonly signature: string | undefined;
  /** The parsed JSON body, untrusted and of unknown shape. */
  readonly body: unknown;
}

/**
 * Decide whether an inbound webhook call may become an agent turn.
 *
 * Callers must act on the result before claiming dedup, before writing
 * anything to Convex, and before spawning an agent. The Allowlist is checked
 * here even though the Gateway is also configured to drop non-allowlisted
 * senders and groups at dispatch, because the security property must not
 * depend on configuration living on a different machine.
 */
export async function admitInboundWhatsappMessage(
  call: InboundWhatsappCall,
): Promise<WhatsappAdmission> {
  // 1. Signature. Nothing below this line runs for a call Boop cannot
  //    attribute to its own Gateway.
  if (!call.signature) return drop("unsigned");
  if (!verifyWhatsappWebhookSecret(call.signature)) {
    // Worth seeing: a wrong secret is either a forged call or a Gateway still
    // registered with a stale one, and both go silent otherwise.
    console.warn("[whatsapp] refused a webhook call: the signing secret did not match");
    return drop("bad-signature");
  }

  const envelope = readEnvelope(call.body);
  if (!envelope) {
    // The analogue of a loud address-format drop: a Gateway upgrade that
    // changes the envelope would otherwise make Boop quietly stop answering.
    console.warn(
      "[whatsapp] a signed webhook call did not carry the expected envelope " +
        "(webhookId / event / payload) - if the gateway has been upgraded, " +
        "server/openwa/inbound.ts is the file to fix",
    );
    return drop("malformed");
  }
  if (envelope.event !== MESSAGE_EVENT) return drop("not-a-message");

  const message = readMessage(envelope.payload);
  if (!message) return drop("malformed");
  if (message.fromMe) return drop("own-message");
  // Checked here as well as through the sender's address, because a Gateway
  // that puts the participant rather than the chat in `from` would otherwise
  // admit a group message from an allowlisted person.
  if (isGroupMessage(message)) return drop("group");

  // 2. Sender resolution to a Handle, then 3. the Allowlist. Both live in
  //    `handles.ts` and both log their own drops.
  const sender = await admitWhatsappSender(message.from);
  if (!sender.ok) return drop(sender.reason);

  // Last, so that nothing about admitting a sender depends on what they sent.
  // An image with no caption lands here today because inbound media is not
  // ingested yet; that is where media ingest hooks in.
  const text = (message.body || message.caption || "").trim();
  if (!text) return drop("empty");

  return {
    admitted: true,
    message: {
      handle: sender.handle,
      conversationId: `whatsapp:${sender.handle}`,
      externalMessageId: message.id,
      text,
    },
  };
}

/** The Gateway's envelope, of which only two fields are load-bearing. */
interface Envelope {
  readonly event: string;
  readonly payload: unknown;
}

/** The message fields Boop reads. Everything else the Gateway sends is ignored. */
interface RawMessage {
  readonly from: string;
  readonly id?: string;
  readonly body?: string;
  readonly caption?: string;
  readonly fromMe?: boolean;
  readonly isGroupMsg?: boolean;
  readonly chatId?: string;
}

function drop(reason: WhatsappDropReason): WhatsappAdmission {
  return { admitted: false, reason };
}

function readEnvelope(body: unknown): Envelope | null {
  if (!isRecord(body)) return null;
  if (typeof body.event !== "string" || !body.event) return null;
  return { event: body.event, payload: body.payload };
}

function readMessage(payload: unknown): RawMessage | null {
  if (!isRecord(payload)) return null;
  const message = payload.message;
  if (!isRecord(message)) return null;
  // A message with no sender is not a message shape Boop understands, and
  // guessing one would be the opposite of a gate.
  const from = message.from;
  if (typeof from !== "string" || !from.trim()) return null;
  return {
    from,
    id: str(message.id),
    body: str(message.body),
    caption: str(message.caption),
    fromMe: message.fromMe === true,
    isGroupMsg: message.isGroupMsg === true,
    chatId: str(message.chatId),
  };
}

function isGroupMessage(message: RawMessage): boolean {
  if (message.isGroupMsg) return true;
  return message.chatId !== undefined && parseWhatsappAddress(message.chatId).kind === "group";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
