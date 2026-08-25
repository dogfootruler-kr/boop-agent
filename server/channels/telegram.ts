/**
 * The `telegram` Channel, with the Telegram Bot API as its Gateway.
 *
 * The Gateway lives in `server/telegram/`; what lives here is the part that is
 * about Telegram the destination rather than the Bot API the client, which is
 * outbound formatting.
 *
 * Telegram is given HTML rather than its own MarkdownV2. Both are supported by
 * the Bot API, but MarkdownV2 requires escaping eighteen characters anywhere
 * they appear, including inside link targets and code spans, and a single
 * missed one rejects the whole message. HTML needs three characters escaped
 * and has explicit closing tags, so a malformed run damages one span instead
 * of the entire reply.
 */
import {
  sendTelegramPart,
  startTelegramTyping,
  TELEGRAM_MAX_MESSAGE_CHARS,
} from "../telegram/api.js";
import { loadTelegramConfig } from "../telegram/config.js";
import { registerChannel, type Channel } from "./registry.js";

/** A fenced code block, with its language tag and its body. */
const FENCE_RE = /```([^\n`]*)\n?([\s\S]*?)```/g;
/** An inline code span. */
const INLINE_CODE_RE = /`([^`\n]+)`/g;

/**
 * Delimiters for a stashed code placeholder. See `toTelegramHtml`.
 *
 * Control characters rather than something like ` 3 `, which would collide
 * with ordinary prose: "in 3 minutes" would come back as a code span. These
 * two survive `escapeHtml` unchanged and match none of the prose patterns.
 */
const STASH_OPEN = "\u0001";
const STASH_CLOSE = "\u0002";
const STASH_RE = /\u0001(\d+)\u0002/g;

/**
 * Translate agent output into the HTML subset Telegram renders.
 *
 * Code blocks are retained rather than stripped: they are the thing markdown
 * stripping damaged most, and Telegram renders them natively.
 */
export function formatForTelegram(text: string): string[] {
  return chunk(toTelegramHtml(text));
}

export const telegramChannel: Channel = {
  key: "telegram",
  formatOutbound: (text) => formatForTelegram(text),
  send: (handle, part) => sendTelegramPart(handle, part),
  startTyping: (handle) => startTelegramTyping(handle),
};

/**
 * Register the `telegram` Channel, but only when its Gateway is configured.
 *
 * Without a bot token the Channel is absent, so an outbound send resolves to
 * nothing and says so once, rather than resolving to an adapter that fails on
 * every call. Someone who only uses iMessage is unaffected.
 */
export function registerTelegramChannel(): void {
  const config = loadTelegramConfig();
  if (!config) {
    console.warn("[channels] telegram not configured (TELEGRAM_BOT_TOKEN missing) - skipping");
    return;
  }
  // The one place that says out loud what was and was not configured, so that
  // a channel which registers but can never admit anyone is not silent about
  // it. Loading itself is silent: it runs per outbound message.
  for (const problem of config.problems) {
    console.warn(`[telegram] ${problem}`);
  }
  registerChannel(telegramChannel);
}

/**
 * Convert markdown to Telegram HTML.
 *
 * Code is extracted before anything else runs so that a `*` inside a code
 * block is never read as emphasis, and its contents are HTML-escaped but
 * otherwise passed through untouched.
 */
function toTelegramHtml(text: string): string {
  const code: string[] = [];
  const stash = (html: string): string => {
    code.push(html);
    return `${STASH_OPEN}${code.length - 1}${STASH_CLOSE}`;
  };

  let withoutFences = "";
  let cursor = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    withoutFences += text.slice(cursor, match.index);
    const language = match[1].trim();
    const body = escapeHtml(match[2].replace(/\n+$/, ""));
    withoutFences += stash(
      language
        ? `<pre><code class="language-${escapeHtml(language)}">${body}</code></pre>`
        : `<pre>${body}</pre>`,
    );
    cursor = match.index + match[0].length;
  }
  withoutFences += text.slice(cursor);

  const withoutCode = withoutFences.replace(INLINE_CODE_RE, (_, body: string) =>
    stash(`<code>${escapeHtml(body)}</code>`),
  );

  const prose = translateProse(escapeHtml(withoutCode));
  return prose.replace(STASH_RE, (_, index: string) => code[Number(index)] ?? "").trim();
}

/**
 * Translate one run of already-escaped text known to contain no code.
 *
 * Order matters throughout, and every emphasis pattern stops at a newline so
 * that a stray marker cannot swallow a paragraph.
 */
function translateProse(text: string): string {
  return (
    text
      // Telegram has no headings, and bold is the closest honest rendering.
      .replace(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/gm, "<b>$1</b>")
      .replace(/\*\*\*([^\n]+?)\*\*\*/g, "<b><i>$1</i></b>")
      .replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>")
      .replace(/__([^\n]+?)__/g, "<b>$1</b>")
      // `(?!\s)` leaves `* item` bullets alone.
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/gm, "$1<i>$2</i>")
      .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/gm, "$1<i>$2</i>")
      .replace(/~~([^\n]+?)~~/g, "<s>$1</s>")
      // Markdown links become real anchors; Telegram renders them inline. The
      // target is escaped text by this point, so `&` in a query string is
      // already `&amp;`, which is what an HTML attribute wants anyway.
      .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
  );
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Split rendered HTML into parts Telegram will accept.
 *
 * Splitting happens on line boundaries so a tag is never cut in half. A `<pre>`
 * block long enough to straddle a boundary is closed at the end of one part
 * and reopened at the start of the next, because Telegram parses each message
 * independently and an unclosed tag would reject the whole part.
 */
function chunk(html: string, size = TELEGRAM_MAX_MESSAGE_CHARS): string[] {
  if (html.length <= size) return [html];

  const out: string[] = [];
  let buf = "";
  // Whether the running text is inside a `<pre>` that has not closed yet.
  let inPre = false;
  // Whether the part currently being built started inside one, and therefore
  // needs an opening `<pre>` of its own.
  let partOpensInPre = false;

  for (const line of html.split("\n")) {
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length > size && buf) {
      out.push(inPre ? `${buf}\n</pre>` : buf);
      partOpensInPre = inPre;
      buf = partOpensInPre ? `<pre>${line}` : line;
    } else {
      buf = candidate;
    }
    // Counting opens and closes rather than assuming one per line: a short
    // block can open and close on the same line.
    const opens = (line.match(/<pre[\s>]/g) ?? []).length;
    const closes = (line.match(/<\/pre>/g) ?? []).length;
    if (opens > closes) inPre = true;
    else if (closes > opens) inPre = false;
  }
  if (buf) out.push(buf);
  return out;
}
