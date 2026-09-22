import { describe, expect, it, vi } from "vitest";

import { redispatchStaleQueuedNotifications } from "@/lib/notifications/redispatch-queued";

// The warm-up backstop (docs/architecture/overview.md):
// re-drives notifications stuck in status='queued' after a lost post-commit
// emit, within a bounded (grace, max-age) window, idempotently.

type Row = { id: string; teacherId: string; createdAt: Date; status: string };

function fakePrisma(rows: Row[]) {
  return {
    notification: {
      findMany: vi.fn(async ({ where, take }: { where: any; take: number }) => {
        const { gte, lt } = where.createdAt;
        return rows
          .filter((r) => r.status === where.status && r.createdAt >= gte && r.createdAt < lt)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take)
          .map((r) => ({ id: r.id, teacherId: r.teacherId }));
      }),
    },
  };
}

const NOW = new Date("2026-07-22T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("redispatchStaleQueuedNotifications", () => {
  it("re-emits only queued rows inside the (grace, max-age) window", async () => {
    const rows: Row[] = [
      { id: "fresh", teacherId: "t1", createdAt: minutesAgo(5), status: "queued" }, // within grace → skip
      { id: "stale", teacherId: "t1", createdAt: minutesAgo(30), status: "queued" }, // in window → re-emit
      { id: "ancient", teacherId: "t2", createdAt: hoursAgo(48), status: "queued" }, // past max-age → skip
    ];
    const emit = vi.fn(async (_input: { notificationId: string; teacherId: string }) => {});

    const result = await redispatchStaleQueuedNotifications({
      prisma: fakePrisma(rows) as never,
      emit,
      now: NOW,
    });

    expect(result).toEqual({ found: 1, reEmitted: 1 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ notificationId: "stale", teacherId: "t1" });
  });

  it("ignores rows that are not queued (already sending/sent/failed)", async () => {
    const rows: Row[] = [
      { id: "sending", teacherId: "t1", createdAt: minutesAgo(30), status: "sending" },
      { id: "sent", teacherId: "t1", createdAt: minutesAgo(30), status: "sent" },
      { id: "failed", teacherId: "t1", createdAt: minutesAgo(30), status: "failed" },
    ];
    const emit = vi.fn(async (_input: { notificationId: string; teacherId: string }) => {});

    const result = await redispatchStaleQueuedNotifications({
      prisma: fakePrisma(rows) as never,
      emit,
      now: NOW,
    });

    expect(result).toEqual({ found: 0, reEmitted: 0 });
    expect(emit).not.toHaveBeenCalled();
  });

  it("re-emits every stale row with its own teacherId, honoring the limit", async () => {
    const rows: Row[] = [
      { id: "a", teacherId: "t1", createdAt: minutesAgo(20), status: "queued" },
      { id: "b", teacherId: "t2", createdAt: minutesAgo(25), status: "queued" },
      { id: "c", teacherId: "t3", createdAt: minutesAgo(30), status: "queued" },
    ];
    const emit = vi.fn(async (_input: { notificationId: string; teacherId: string }) => {});

    const result = await redispatchStaleQueuedNotifications({
      prisma: fakePrisma(rows) as never,
      emit,
      now: NOW,
      limit: 2,
    });

    expect(result).toEqual({ found: 2, reEmitted: 2 });
    // oldest-first ordering → b and c are the two oldest within window
    expect(emit.mock.calls.map((c) => c[0].notificationId)).toEqual(["c", "b"]);
  });
});
