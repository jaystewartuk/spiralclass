import { describe, expect, it, vi } from "vitest";
import {
  markWebhookEventProcessed,
  recordWebhookEvent,
  releaseWebhookEvent,
  webhookEventSeen,
} from "@/lib/webhooks/idempotency";

// Webhook replay + durability guard (docs/security.md, D-79).
// The claim row has three meanings and recordWebhookEvent reports which:
//   * claimed   — fresh insert, or a stale dead claim re-stolen → run the handler
//   * processed — a prior delivery set processedAt → true duplicate, ack 200
//   * in_flight — a fresh unprocessed claim is held → caller must retry later
// markWebhookEventProcessed stamps completion; releaseWebhookEvent deletes on throw.

const NOW = new Date("2026-06-12T12:00:00.000Z");

type Row = {
  provider: string;
  eventId: string;
  eventType?: string | null;
  receivedAt: Date;
  processedAt: Date | null;
};

function makeDb(seed: Row[] = [], opts: { createError?: unknown } = {}) {
  const rows = new Map<string, Row>();
  const key = (p: string, e: string) => `${p}:${e}`;
  for (const r of seed) rows.set(key(r.provider, r.eventId), r);

  const db = {
    webhookEvent: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: vi.fn(async ({ data }: any) => {
        if (opts.createError) throw opts.createError;
        const k = key(data.provider, data.eventId);
        if (rows.has(k)) {
          throw Object.assign(new Error("unique constraint"), { code: "P2002" });
        }
        rows.set(k, {
          provider: data.provider,
          eventId: data.eventId,
          eventType: data.eventType ?? null,
          receivedAt: NOW,
          processedAt: null,
        });
        return {};
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: vi.fn(async ({ where }: any) => {
        const { provider, eventId } = where.provider_eventId;
        return rows.get(key(provider, eventId)) ?? null;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.get(key(where.provider, where.eventId));
        if (!row) return { count: 0 };
        if (where.processedAt === null && row.processedAt !== null) return { count: 0 };
        if (where.receivedAt?.lt && !(row.receivedAt < where.receivedAt.lt)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deleteMany: vi.fn(async ({ where }: any) => {
        return { count: rows.delete(key(where.provider, where.eventId)) ? 1 : 0 };
      }),
    },
  };
  return { db: db as never, rows, key };
}

const STALE = 10 * 60 * 1000;

describe("recordWebhookEvent", () => {
  it("claims a fresh event (inserts an unprocessed row)", async () => {
    const { db, rows } = makeDb();
    const res = await recordWebhookEvent(
      db,
      { provider: "stripe", eventId: "e1", eventType: "checkout.session.completed" },
      { now: NOW },
    );
    expect(res).toEqual({ status: "claimed" });
    expect(rows.get("stripe:e1")).toMatchObject({ processedAt: null });
  });

  it("defaults eventType to null when omitted", async () => {
    const { db, rows } = makeDb();
    await recordWebhookEvent(db, { provider: "inngest", eventId: "w1" }, { now: NOW });
    expect(rows.get("inngest:w1")!.eventType).toBeNull();
  });

  it("reports 'processed' for a completed prior delivery (true duplicate)", async () => {
    const { db } = makeDb([
      { provider: "stripe", eventId: "dup", receivedAt: NOW, processedAt: NOW },
    ]);
    const res = await recordWebhookEvent(db, { provider: "stripe", eventId: "dup" }, { now: NOW });
    expect(res).toEqual({ status: "processed" });
  });

  it("reports 'in_flight' for a fresh unprocessed claim (concurrent delivery)", async () => {
    const { db } = makeDb([
      {
        provider: "stripe",
        eventId: "race",
        receivedAt: new Date(NOW.getTime() - 2 * 60_000), // 2 min ago — within window
        processedAt: null,
      },
    ]);
    const res = await recordWebhookEvent(
      db,
      { provider: "stripe", eventId: "race" },
      { now: NOW, staleClaimMs: STALE },
    );
    expect(res).toEqual({ status: "in_flight" });
  });

  it("reclaims a STALE unprocessed claim (a prior attempt died) and re-stamps it", async () => {
    const stale = {
      provider: "stripe",
      eventId: "dead",
      receivedAt: new Date(NOW.getTime() - 20 * 60_000), // 20 min ago — past window
      processedAt: null,
    };
    const { db, rows } = makeDb([stale]);
    const res = await recordWebhookEvent(
      db,
      { provider: "stripe", eventId: "dead" },
      { now: NOW, staleClaimMs: STALE },
    );
    expect(res).toEqual({ status: "claimed" });
    // Re-stamped so a racing retry can't also reclaim it.
    expect(rows.get("stripe:dead")!.receivedAt).toEqual(NOW);
  });

  it("rethrows a non-unique-constraint create error", async () => {
    const { db } = makeDb([], { createError: new Error("db down") });
    await expect(
      recordWebhookEvent(db, { provider: "stripe", eventId: "x" }, { now: NOW }),
    ).rejects.toThrow("db down");
  });
});

describe("markWebhookEventProcessed", () => {
  it("stamps processedAt so a later delivery is a true duplicate", async () => {
    const { db, rows } = makeDb([
      { provider: "stripe", eventId: "e1", receivedAt: NOW, processedAt: null },
    ]);
    await markWebhookEventProcessed(db, { provider: "stripe", eventId: "e1" }, NOW);
    expect(rows.get("stripe:e1")!.processedAt).toEqual(NOW);
    // A subsequent claim now reads as processed.
    expect(
      await recordWebhookEvent(db, { provider: "stripe", eventId: "e1" }, { now: NOW }),
    ).toEqual({ status: "processed" });
  });
});

describe("releaseWebhookEvent", () => {
  it("deletes the claim so the provider's retry re-claims", async () => {
    const { db, rows } = makeDb([
      { provider: "stripe", eventId: "e1", receivedAt: NOW, processedAt: null },
    ]);
    await releaseWebhookEvent(db, { provider: "stripe", eventId: "e1" });
    expect(rows.has("stripe:e1")).toBe(false);
    expect(
      await recordWebhookEvent(db, { provider: "stripe", eventId: "e1" }, { now: NOW }),
    ).toEqual({ status: "claimed" });
  });
});

describe("webhookEventSeen", () => {
  it("true once claimed, false when never seen", async () => {
    const { db } = makeDb([
      { provider: "stripe", eventId: "seen", receivedAt: NOW, processedAt: null },
    ]);
    expect(await webhookEventSeen(db, { provider: "stripe", eventId: "seen" })).toBe(true);
    expect(await webhookEventSeen(db, { provider: "stripe", eventId: "nope" })).toBe(false);
  });
});
