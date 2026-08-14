import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * How long a claim must survive to keep absorbing Gateway retries. Webhook
 * retries from any gateway span minutes, not days, so 24 hours is a wide
 * safety margin; after that a claim is dead weight and eligible for cleanup.
 */
export const CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Rows deleted per cleanup run, keeping each mutation small and conflict-free. */
const CLEANUP_BATCH_SIZE = 100;

/**
 * Claim an inbound message so a Gateway retry does not reach the agent twice.
 *
 * Channel-agnostic by design: the key is (channel, externalMessageId), so a
 * second channel needs no second dedup table. Rows are ephemeral claim
 * markers with no historical value.
 */
export const claim = mutation({
  args: { channel: v.string(), externalMessageId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("channelDedup")
      .withIndex("by_channel_external_id", (q) =>
        q.eq("channel", args.channel).eq("externalMessageId", args.externalMessageId),
      )
      .unique();
    if (existing) return { claimed: false };
    await ctx.db.insert("channelDedup", {
      channel: args.channel,
      externalMessageId: args.externalMessageId,
      claimedAt: Date.now(),
    });
    return { claimed: true };
  },
});

/**
 * Delete claims older than CLAIM_RETENTION_MS in bounded batches. Runs from
 * the hourly cron; when a full batch is deleted it reschedules itself
 * immediately so a backlog drains without one oversized mutation.
 */
export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - CLAIM_RETENTION_MS;
    const expired = await ctx.db
      .query("channelDedup")
      .withIndex("by_claimed_at", (q) => q.lt("claimedAt", cutoff))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }
    if (expired.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.channelDedup.cleanupExpired, {});
    }
  },
});
