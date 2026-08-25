/**
 * Authenticating an inbound webhook call from the Telegram Bot API.
 *
 * Same shape as `server/openwa/webhook-auth.ts`: a secret derived by
 * HMAC-SHA256 from a credential both sides already hold, compared in constant
 * time. Telegram does not sign a request body - it echoes back the
 * `secret_token` that was supplied at `setWebhook` time - so what arrives is
 * the secret Boop registered, and comparing it is the whole verification.
 *
 * The secret is derived rather than picked, so no human chooses it, nothing
 * has to store it, and no env var has to be kept in sync between the process
 * that registers the webhook and the one that verifies it. Rotating the bot
 * token rotates the webhook secret and forces a re-registration, which is the
 * right way round: a leaked bot token is already a reason to rotate both.
 *
 * Hex output satisfies Telegram's own rule for this field, which allows only
 * `A-Z`, `a-z`, `0-9`, `_` and `-`, between 1 and 256 characters.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const WEBHOOK_SECRET_CONTEXT = "boop-telegram-webhook-v1";

/**
 * The header Telegram echoes the registered `secret_token` back in.
 *
 * Exported so that the handler reading it and the registration writing it
 * cannot drift apart.
 */
export const TELEGRAM_WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** The value Boop registers with Telegram, and expects back on every call. */
export function deriveTelegramWebhookSecret(botToken: string): string {
  return createHmac("sha256", botToken).update(WEBHOOK_SECRET_CONTEXT).digest("hex");
}

/**
 * Check a received secret token against the derived one, in constant time.
 *
 * False when the Gateway is not configured at all: with no bot token there is
 * nothing to verify against, and admitting an unverifiable call would be the
 * one failure mode this function exists to prevent.
 */
export function verifyTelegramWebhookSecret(
  received: string | undefined,
  botToken = process.env.TELEGRAM_BOT_TOKEN?.trim(),
): boolean {
  if (!received || !botToken) return false;

  const expected = Buffer.from(deriveTelegramWebhookSecret(botToken));
  const actual = Buffer.from(received);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
