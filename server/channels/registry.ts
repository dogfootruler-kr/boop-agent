/**
 * The Channel port and its registry.
 *
 * A Channel is a bidirectional messaging transport the user talks to Boop
 * through. It is identified by a short key that is also the prefix of every
 * Conversation ID belonging to it, which makes the Conversation ID the routing
 * key for everything outbound.
 *
 * Channels are deliberately NOT Integrations and are registered here rather
 * than through `registerIntegration`. An Integration is a capability an
 * execution agent uses to get work done; a Channel is how the user reaches
 * Boop at all. The dispatcher reads `server/integrations/registry.ts` only, so
 * it never sees a Channel as spawnable.
 */

/**
 * The channel keys Boop knows about.
 *
 * A key listed here is a channel Boop can route to once an adapter for it is
 * registered; it is not a promise that one is.
 */
export const CHANNEL_KEYS = ["sms", "whatsapp", "telegram"] as const;

export type ChannelKey = (typeof CHANNEL_KEYS)[number];

/** Stops a typing indication started by `Channel.startTyping`. */
export type StopTyping = () => void;

export interface Channel {
  /** Short key, also the Conversation ID prefix for this channel. */
  readonly key: ChannelKey;
  /**
   * Split agent output into the parts this channel's Gateway accepts.
   *
   * Per-channel differences live here rather than in branches at the call
   * site: iMessage wants markdown stripped and short chunks, another channel
   * may want its own markup and a far higher threshold.
   */
  formatOutbound(text: string): string[];
  /** Deliver one already-formatted part to a Handle. */
  send(handle: string, part: string): Promise<void>;
  /** Show a typing indication to a Handle. The returned function stops it. */
  startTyping(handle: string): StopTyping;
}

const registry = new Map<ChannelKey, Channel>();

export function registerChannel(channel: Channel): void {
  registry.set(channel.key, channel);
}

export function isChannelKey(value: string): value is ChannelKey {
  return (CHANNEL_KEYS as readonly string[]).includes(value);
}

export function getChannel(key: string): Channel | undefined {
  return isChannelKey(key) ? registry.get(key) : undefined;
}

export function listChannels(): Channel[] {
  return [...registry.values()];
}

export function clearChannels(): void {
  registry.clear();
}

/**
 * Split a Conversation ID into its channel key and Handle.
 *
 * The key is returned as written, not validated: a Conversation ID with a
 * prefix that is not a channel key at all (the debug UI has its own threads)
 * parses fine and simply resolves to no channel.
 */
export function parseConversationId(
  conversationId: string,
): { channelKey: string; handle: string } | null {
  const idx = conversationId.indexOf(":");
  if (idx <= 0) return null;
  const handle = conversationId.slice(idx + 1);
  if (!handle) return null;
  return { channelKey: conversationId.slice(0, idx), handle };
}

/** Human-readable Channel name for a prompt: "WhatsApp", never "whatsapp:". */
const CHANNEL_DISPLAY_NAMES: Record<ChannelKey, string> = {
  sms: "iMessage",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

/**
 * The display name of the Channel a Conversation ID belongs to, derived from
 * its prefix via `parseConversationId`.
 *
 * Null when the prefix is not a known channel key, which is expected for
 * Conversation IDs that don't belong to a Channel at all (the debug UI has
 * its own threads). This does not require the Channel to be registered: the
 * name is derivable from the prefix alone, unlike `resolveChannel`.
 */
export function channelDisplayName(conversationId: string): string | null {
  const parsed = parseConversationId(conversationId);
  if (!parsed || !isChannelKey(parsed.channelKey)) return null;
  return CHANNEL_DISPLAY_NAMES[parsed.channelKey];
}

/**
 * Resolve a Conversation ID to the Channel it belongs to and the Handle on it.
 *
 * An unconfigured channel resolves to nothing rather than to a broken adapter,
 * because an adapter registers only once its Gateway is configured.
 */
export function resolveChannel(
  conversationId: string,
): { channel: Channel; handle: string } | null {
  const parsed = parseConversationId(conversationId);
  if (!parsed) return null;
  const channel = getChannel(parsed.channelKey);
  if (!channel) return null;
  return { channel, handle: parsed.handle };
}

/**
 * Register every configured Channel adapter.
 *
 * Adapters are imported lazily so an adapter can import this module for the
 * port types without a cycle.
 */
export async function loadChannels(): Promise<void> {
  clearChannels();
  const { registerSmsChannel } = await import("./sms.js");
  registerSmsChannel();
  const { registerWhatsappChannel } = await import("./whatsapp.js");
  registerWhatsappChannel();
  const { registerTelegramChannel } = await import("./telegram.js");
  registerTelegramChannel();
  const keys = listChannels().map((c) => c.key);
  console.log(
    `[channels] registered: ${keys.join(", ") || "(none - no messaging gateway is configured)"}`,
  );
}
