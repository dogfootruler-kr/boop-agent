/**
 * The `whatsapp` Channel, with OpenWA as its Gateway.
 *
 * The Gateway lives in `server/openwa/`; what lives here is the part that is
 * about WhatsApp the destination rather than OpenWA the client, which is
 * outbound formatting. That split is deliberate: OpenWA is a
 * reverse-engineered WhatsApp client and is expected to be swapped out, and a
 * replacement would keep every line of this file's formatting.
 */
import { sendWhatsappPart, startWhatsappTyping } from "../openwa/gateway.js";
import { loadWhatsappConfig } from "../openwa/config.js";
import { registerChannel, type Channel } from "./registry.js";

/**
 * WhatsApp accepts around 65,000 characters in one message, so a long reply
 * arrives whole. Applying iMessage's 2,900-character rule here would chop a
 * detailed answer into fragments for no reason.
 */
const MAX_CHUNK = 65_000;

/**
 * Sentinels standing in for WhatsApp bold while italic is being translated.
 *
 * WhatsApp bold is `*text*` and markdown italic is also `*text*`, so
 * translating bold first and italic second would re-read the bold it just
 * produced as italic. Holding bold aside until the end is what stops that.
 */
const BOLD_OPEN = "\u0000";
const BOLD_CLOSE = "\u0001";

/** A fenced code block, with its language tag and its body. */
const FENCE_RE = /```([^\n`]*)\n?([\s\S]*?)```/g;

/**
 * Translate agent output into WhatsApp's own markup.
 *
 * WhatsApp renders `*bold*`, `_italic_`, `~strikethrough~` and triple-backtick
 * monospace, so unlike iMessage it is worth translating into rather than
 * stripping. Code blocks are retained: they are the thing markdown stripping
 * damaged most.
 */
export function formatForWhatsapp(text: string): string[] {
  return chunk(toWhatsappMarkup(text));
}

export const whatsappChannel: Channel = {
  key: "whatsapp",
  formatOutbound: (text) => formatForWhatsapp(text),
  send: (handle, part) => sendWhatsappPart(handle, part),
  startTyping: (handle) => startWhatsappTyping(handle),
};

/**
 * Register the `whatsapp` Channel, but only when its Gateway is configured.
 *
 * Without a Gateway the Channel is absent, so an outbound send resolves to
 * nothing and says so once, rather than resolving to an adapter that fails on
 * every call. Someone who only uses iMessage is unaffected.
 */
export function registerWhatsappChannel(): void {
  const config = loadWhatsappConfig();
  if (!config) {
    console.warn(
      "[channels] whatsapp not configured (WHATSAPP_GATEWAY_URL / WHATSAPP_API_KEY missing) - skipping",
    );
    return;
  }
  // The one place that says out loud what was and was not configured, so that
  // a channel which registers but can never admit anyone is not silent about
  // it. Loading itself is silent: it runs per outbound message.
  for (const problem of config.problems) {
    console.warn(`[whatsapp] ${problem}`);
  }
  registerChannel(whatsappChannel);
}

function toWhatsappMarkup(text: string): string {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    const start = match.index;
    out += translateProse(text.slice(cursor, start));
    // The language tag goes: WhatsApp does not understand it and would render
    // it as the first line of the block.
    out += "```\n" + match[2].replace(/\n+$/, "") + "\n```";
    cursor = start + match[0].length;
  }
  return (out + translateProse(text.slice(cursor))).trim();
}

/**
 * Translate one run of text that is known not to be inside a code block.
 *
 * Order matters throughout, and every pattern stops at a newline so that a
 * stray marker cannot swallow a paragraph.
 */
function translateProse(text: string): string {
  return (
    text
      // WhatsApp has no headings, and bold is the closest honest rendering.
      .replace(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/gm, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
      .replace(/\*\*\*([^\n]+?)\*\*\*/g, `_${BOLD_OPEN}$1${BOLD_CLOSE}_`)
      .replace(/\*\*([^\n]+?)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
      .replace(/__([^\n]+?)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
      // `(?!\s)` leaves `* item` bullets alone, which WhatsApp renders itself.
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/gm, "$1_$2_")
      .replace(/~~([^\n]+?)~~/g, "~$1~")
      // WhatsApp does not linkify markdown link syntax, so it is unwrapped.
      .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
      .replaceAll(BOLD_OPEN, "*")
      .replaceAll(BOLD_CLOSE, "*")
  );
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}
