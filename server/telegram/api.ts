/**
 * The Telegram Bot API client: the `telegram` Channel's Gateway.
 *
 * Every call goes to `https://api.telegram.org/bot<token>/<method>`, which is
 * the one place the bot token is ever interpolated. The token is a credential
 * that sits in a URL rather than a header, so nothing here logs a request URL;
 * failures are reported by method name only.
 */
import { loadTelegramConfig } from "./config.js";

const API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 15_000;

/** Telegram truncates at 4096 UTF-16 code units; a small margin is kept. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4000;

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly statusCode: number | undefined,
    description: string,
  ) {
    super(`telegram ${method} failed: ${description}`);
    this.name = "TelegramApiError";
  }
}

/**
 * Call one Bot API method.
 *
 * Throws `TelegramApiError` on both a transport failure and an `ok: false`
 * body, because to every caller here they are the same event: the message did
 * not go out. The description Telegram returns is preserved - it is specific
 * ("chat not found", "bot was blocked by the user") and is the only useful
 * thing in an otherwise opaque failure.
 */
export async function callTelegram<T>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const config = loadTelegramConfig();
  if (!config) throw new TelegramApiError(method, undefined, "telegram is not configured");

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${config.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new TelegramApiError(method, undefined, String(err));
  }

  let body: TelegramResponse<T>;
  try {
    body = (await res.json()) as TelegramResponse<T>;
  } catch {
    throw new TelegramApiError(method, res.status, `non-JSON response (HTTP ${res.status})`);
  }
  if (!body.ok || body.result === undefined) {
    throw new TelegramApiError(method, res.status, body.description ?? `HTTP ${res.status}`);
  }
  return body.result;
}

/**
 * Send one already-formatted part to a chat.
 *
 * `parse_mode: HTML` matches what `formatForTelegram` produces. A part that
 * Telegram rejects as malformed HTML is retried once as plain text, because
 * losing the formatting on one reply is a far better outcome than losing the
 * reply: the agent's output is not under our control and a construction that
 * escapes the formatter would otherwise silently drop the message.
 */
export async function sendTelegramPart(chatId: string, part: string): Promise<void> {
  try {
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: part,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (!(err instanceof TelegramApiError) || !/can't parse entities/i.test(err.message)) throw err;
    console.warn("[telegram] HTML parse rejected by Telegram; resending as plain text");
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: stripHtmlTags(part),
      link_preview_options: { is_disabled: true },
    });
  }
}

/**
 * Show the "typing…" status in a chat.
 *
 * Telegram clears the status after about five seconds, so it is re-sent on a
 * four-second interval until the returned function stops it. Failures are
 * swallowed: a missing typing indicator must never take down the turn that
 * produces the actual answer.
 */
export function startTelegramTyping(chatId: string): () => void {
  const ping = () => {
    void callTelegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  };
  ping();
  const timer = setInterval(ping, 4000);
  return () => clearInterval(timer);
}

/** Resolve a Telegram `file_id` to a temporary download URL. */
export async function telegramFileUrl(fileId: string): Promise<string> {
  const config = loadTelegramConfig();
  if (!config) throw new TelegramApiError("getFile", undefined, "telegram is not configured");
  const file = await callTelegram<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new TelegramApiError("getFile", undefined, "no file_path in response");
  return `${API_BASE}/file/bot${config.botToken}/${file.file_path}`;
}

/** Remove HTML tags, for the plain-text retry path. */
function stripHtmlTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}
