/**
 * Configuration for the `telegram` Channel's Gateway, the Telegram Bot API.
 *
 * Unlike OpenWA there is no self-hosted gateway process to point at: the
 * Gateway is Telegram's own cloud, addressed by a bot token. What has to be
 * configured is therefore only the token and who is allowed to talk to the
 * bot. The webhook secret is not configured at all - it is derived from the
 * token in `server/telegram/webhook-auth.ts`.
 */
export interface TelegramConfig {
  readonly botToken: string;
  /**
   * Chat IDs allowed to reach Boop, as strings.
   *
   * A Telegram chat ID is a signed integer (negative for groups), which is why
   * these are kept as strings rather than numbers: they are compared, never
   * used in arithmetic, and a string comparison cannot lose precision on an ID
   * that exceeds `Number.MAX_SAFE_INTEGER`.
   */
  readonly allowedChatIds: ReadonlySet<string>;
  /**
   * Usernames allowed to reach Boop, lowercased and without the leading `@`.
   *
   * Accepted as a convenience for the common case of not yet knowing your own
   * numeric chat ID. A username can be changed by its owner at any time, so a
   * chat ID is the stronger allowlist entry and the one to prefer.
   */
  readonly allowedUsernames: ReadonlySet<string>;
  /** Non-fatal configuration problems, logged once at registration. */
  readonly problems: readonly string[];
}

/**
 * Parse `TELEGRAM_ALLOWLIST` into chat IDs and usernames.
 *
 * Entries are comma-separated and may be either a numeric chat ID
 * (`123456789`, or `-1001234567890` for a group) or a `@username`.
 */
function parseAllowlist(raw: string | undefined): {
  chatIds: Set<string>;
  usernames: Set<string>;
  rejected: string[];
} {
  const chatIds = new Set<string>();
  const usernames = new Set<string>();
  const rejected: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (/^-?\d+$/.test(trimmed)) {
      chatIds.add(trimmed);
    } else if (/^@[A-Za-z0-9_]{4,}$/.test(trimmed)) {
      usernames.add(trimmed.slice(1).toLowerCase());
    } else {
      rejected.push(JSON.stringify(trimmed));
    }
  }
  return { chatIds, usernames, rejected };
}

/**
 * Load the Telegram configuration, or null when the Channel is not configured.
 *
 * Null means "no Gateway", which is what keeps the Channel unregistered and
 * every outbound send to it resolving to nothing. A configured-but-flawed
 * setup returns a config with `problems` instead, because a bot that is
 * reachable but allowlists nobody is a different failure from one that was
 * never set up, and only the first is worth a warning on every boot.
 */
export function loadTelegramConfig(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) return null;

  const problems: string[] = [];
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    problems.push(
      "TELEGRAM_BOT_TOKEN does not look like a BotFather token (expected `<digits>:<letters>`)",
    );
  }

  const { chatIds, usernames, rejected } = parseAllowlist(process.env.TELEGRAM_ALLOWLIST);
  for (const entry of rejected) {
    problems.push(
      `TELEGRAM_ALLOWLIST entry ${entry} was ignored - write it as a numeric chat ID (123456789) or as @username`,
    );
  }
  if (chatIds.size === 0 && usernames.size === 0) {
    problems.push(
      "TELEGRAM_ALLOWLIST is empty - every inbound Telegram message will be dropped. Message the bot once and read your chat ID off the [telegram] drop line in this log.",
    );
  }

  return { botToken, allowedChatIds: chatIds, allowedUsernames: usernames, problems };
}

/** Whether the `telegram` Channel has a Gateway configured at all. */
export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}
