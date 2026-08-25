/**
 * Keeping Telegram's registered webhook pointed at the current public URL.
 *
 * Telegram holds exactly one webhook URL per bot, so registration is a
 * `setWebhook` call that overwrites whatever was there. That makes this
 * naturally idempotent and makes a rotating tunnel URL a non-event: every boot
 * re-points the bot at wherever Boop is reachable now, the same thing
 * `scripts/sendblue-webhook.mjs` does for Sendblue.
 *
 * `getWebhookInfo` is read first so that an unchanged registration can be
 * reported as such instead of being rewritten, which keeps the boot log honest
 * about whether anything actually moved.
 */
import { callTelegram } from "./api.js";
import { loadTelegramConfig } from "./config.js";
import { deriveTelegramWebhookSecret } from "./webhook-auth.js";

/** The path `createTelegramRouter` is mounted at, relative to the public URL. */
const WEBHOOK_PATH = "/telegram/webhook";

/**
 * Update types Boop asks Telegram to deliver.
 *
 * Narrowed on purpose: the admission gate drops everything except `message`
 * anyway, and asking for less means Telegram does not spend retries delivering
 * updates that were always going to be dropped.
 */
const ALLOWED_UPDATES = ["message"] as const;

export type TelegramWebhookRegistration =
  | { ok: true; state: "unchanged" | "registered"; url: string }
  | { ok: false; reason: string };

interface WebhookInfo {
  url?: string;
  last_error_message?: string;
  last_error_date?: number;
  pending_update_count?: number;
}

/**
 * Point the bot's webhook at `publicUrl`, unless it is already there.
 *
 * A non-HTTPS URL is refused rather than attempted: Telegram requires HTTPS
 * for webhooks and rejects anything else, and saying so here is more useful
 * than relaying the Bot API's own error. A localhost URL is refused for the
 * same reason - Telegram's servers cannot reach it.
 */
export async function ensureTelegramWebhook(
  publicUrl: string,
): Promise<TelegramWebhookRegistration> {
  const config = loadTelegramConfig();
  if (!config) return { ok: false, reason: "TELEGRAM_BOT_TOKEN is not set" };

  const base = publicUrl.replace(/\/+$/, "");
  if (!base.startsWith("https://")) {
    return { ok: false, reason: `Telegram requires an https webhook URL; got ${base}` };
  }
  if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(base)) {
    return { ok: false, reason: "Telegram cannot reach a localhost URL" };
  }
  const url = `${base}${WEBHOOK_PATH}`;

  let info: WebhookInfo | undefined;
  try {
    info = await callTelegram<WebhookInfo>("getWebhookInfo", {});
  } catch (err) {
    // Not fatal: the registration below is what matters, and a failed read
    // only costs the ability to report "unchanged".
    console.warn(`[telegram] could not read the current webhook: ${String(err)}`);
  }

  // Telegram reports the last delivery failure here and nowhere else, so it is
  // surfaced even when the URL is about to be rewritten: "connection refused"
  // against the previous tunnel is exactly what someone debugging needs.
  if (info?.last_error_message) {
    console.warn(`[telegram] last delivery error from Telegram: ${info.last_error_message}`);
  }

  if (info?.url === url) {
    return { ok: true, state: "unchanged", url };
  }

  try {
    await callTelegram("setWebhook", {
      url,
      secret_token: deriveTelegramWebhookSecret(config.botToken),
      allowed_updates: ALLOWED_UPDATES,
      // Updates queued against a tunnel that is now gone are stale by
      // definition, and replaying them would answer messages the user sent
      // hours ago as though they just arrived.
      drop_pending_updates: true,
      max_connections: 10,
    });
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
  return { ok: true, state: "registered", url };
}

/**
 * Remove the bot's webhook.
 *
 * Not called during normal operation. It exists because a bot left pointing at
 * a dead tunnel keeps Telegram retrying against it, and because switching a
 * bot between two machines otherwise silently steals its updates.
 */
export async function clearTelegramWebhook(): Promise<void> {
  await callTelegram("deleteWebhook", { drop_pending_updates: true });
}
