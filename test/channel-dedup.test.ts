import { describe, expect, it } from "vitest";
import { claim } from "../convex/channelDedup.js";

type ClaimArgs = { channel: string; externalMessageId: string };
type ClaimResult = { claimed: boolean };

// `_handler` is set on every registered Convex function at runtime, but the
// published type declarations mark it internal and omit it, so the cast is
// needed to reach it from a test.
const claimHandler = (claim as unknown as {
  _handler: (ctx: { db: ReturnType<typeof createFakeDb> }, args: ClaimArgs) => Promise<ClaimResult>;
})._handler;

/**
 * A minimal fake `ctx.db` covering only what `channelDedup.claim` uses: a
 * `.query(table).withIndex(name, builder).unique()` read and a plain
 * `.insert(table, doc)` write. Convex mutations cannot call `fetch`, so the
 * repo's usual "stub global fetch" style does not apply here; this exercises
 * the exported mutation's own handler directly instead, per
 * `test/setup.ts`'s guidance to mock the Convex client rather than the
 * network for Convex queries/mutations.
 */
function createFakeDb() {
  const rows: Array<{ channel: string; externalMessageId: string; claimedAt: number }> = [];
  return {
    query(table: string) {
      if (table !== "channelDedup") throw new Error(`unexpected table: ${table}`);
      return {
        withIndex(indexName: string, builder: (q: any) => any) {
          if (indexName !== "by_channel_external_id") {
            throw new Error(`unexpected index: ${indexName}`);
          }
          const constraints: Record<string, unknown> = {};
          const q = {
            eq(field: string, value: unknown) {
              constraints[field] = value;
              return q;
            },
          };
          builder(q);
          return {
            async unique() {
              const matches = rows.filter((row) =>
                Object.entries(constraints).every(
                  ([field, value]) => (row as Record<string, unknown>)[field] === value,
                ),
              );
              if (matches.length > 1) throw new Error("expected at most one match");
              return matches[0] ?? null;
            },
          };
        },
      };
    },
    async insert(table: string, doc: { channel: string; externalMessageId: string; claimedAt: number }) {
      if (table !== "channelDedup") throw new Error(`unexpected table: ${table}`);
      rows.push(doc);
    },
  };
}

describe("channelDedup.claim", () => {
  it("claims a repeated (channel, externalMessageId) pair once", async () => {
    const ctx = { db: createFakeDb() } as any;

    const first = await claimHandler(ctx, { channel: "sms", externalMessageId: "msg-1" });
    const second = await claimHandler(ctx, { channel: "sms", externalMessageId: "msg-1" });
    const third = await claimHandler(ctx, { channel: "sms", externalMessageId: "msg-1" });

    expect(first).toEqual({ claimed: true });
    expect(second).toEqual({ claimed: false });
    expect(third).toEqual({ claimed: false });
  });

  it("claims the same external message ID separately per channel", async () => {
    const ctx = { db: createFakeDb() } as any;

    const sms = await claimHandler(ctx, { channel: "sms", externalMessageId: "msg-1" });
    const whatsapp = await claimHandler(ctx, {
      channel: "whatsapp",
      externalMessageId: "msg-1",
    });

    expect(sms).toEqual({ claimed: true });
    expect(whatsapp).toEqual({ claimed: true });
  });

  it("claims distinct external message IDs on the same channel independently", async () => {
    const ctx = { db: createFakeDb() } as any;

    const first = await claimHandler(ctx, { channel: "sms", externalMessageId: "msg-1" });
    const second = await claimHandler(ctx, { channel: "sms", externalMessageId: "msg-2" });

    expect(first).toEqual({ claimed: true });
    expect(second).toEqual({ claimed: true });
  });
});
