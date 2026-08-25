// Point the Telegram bot's webhook at the current public URL. Invoked from
// `scripts/dev.mjs` once a tunnel is up, and runnable by hand when a tunnel
// URL changed outside a restart. Mirrors the Sendblue auto-register flow so
// the user doesn't have to touch BotFather on every restart.
//
// The webhook secret is derived from the bot token rather than stored, so this
// standalone process computes the same value the running server verifies
// against - see `server/telegram/webhook-auth.ts`.
//
// Usage: tsx scripts/telegram-webhook.ts <publicUrl>
//        tsx scripts/telegram-webhook.ts --check
import "../server/env-setup.js";
import { callTelegram } from "../server/telegram/api.js";
import { ensureTelegramWebhook } from "../server/telegram/webhook-registration.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: tsx scripts/telegram-webhook.ts <publicUrl> | --check");
  process.exit(2);
}
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.log("TELEGRAM_BOT_TOKEN not set; skipping Telegram webhook registration");
  process.exit(0);
}

if (arg === "--check") {
  const info = await callTelegram<{
    url?: string;
    pending_update_count?: number;
    last_error_message?: string;
  }>("getWebhookInfo", {});
  console.log(`registered: ${info.url || "none"}`);
  console.log(`pending updates: ${info.pending_update_count ?? 0}`);
  if (info.last_error_message) console.log(`last error: ${info.last_error_message}`);
  process.exit(info.url ? 0 : 1);
}

const result = await ensureTelegramWebhook(arg);
if (!result.ok) {
  console.error(`failed: ${result.reason}`);
  process.exit(1);
}
console.log(`${result.state} ${result.url}`);
