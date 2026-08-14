/**
 * Authenticating an inbound webhook call from the Gateway.
 *
 * Same shape as `server/sendblue-webhook-auth.ts`: a signing secret derived by
 * HMAC-SHA256 from a credential both sides already hold, compared in constant
 * time. OpenWA does not sign a request body itself - it attaches static headers
 * that whoever registered the webhook chose - so what arrives back is the
 * secret Boop registered, and comparing it is the whole verification.
 *
 * The secret is derived rather than picked, so no human chooses it and nothing
 * has to store it: registration and verification recompute the same value from
 * the Gateway API key. Consequently rotating the API key rotates the webhook
 * secret, and the webhook has to be re-registered - which is the right way
 * round, since a leaked API key is already a reason to rotate both.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadWhatsappConfig } from "./config.js";

const WEBHOOK_SECRET_CONTEXT = "boop-whatsapp-webhook-v1";

/**
 * The header the Gateway is registered to send the signing secret in.
 *
 * Exported so that the handler reading it and the registration writing it
 * cannot drift apart.
 */
export const WHATSAPP_WEBHOOK_SECRET_HEADER = "x-webhook-secret";

/** The value Boop registers with the Gateway, and expects back on every call. */
export function deriveWhatsappWebhookSecret(apiKey: string): string {
  return createHmac("sha256", apiKey).update(WEBHOOK_SECRET_CONTEXT).digest("hex");
}

/**
 * Check a received signing secret against the derived one, in constant time.
 *
 * False when the Gateway is not configured at all: with no API key there is
 * nothing to verify against, and admitting an unverifiable call would be the
 * one failure mode this function exists to prevent.
 */
export function verifyWhatsappWebhookSecret(
  received: string | undefined,
  apiKey = loadWhatsappConfig()?.apiKey,
): boolean {
  if (!received || !apiKey) return false;

  const expected = Buffer.from(deriveWhatsappWebhookSecret(apiKey));
  const actual = Buffer.from(received);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
