import { mutation } from "./_generated/server";
import { v } from "convex/values";

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
