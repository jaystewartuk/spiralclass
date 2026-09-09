import { beforeEach, describe, expect, it, vi } from "vitest";

// on-booking-created.ts is the reminder wake chain's creation-time entry
// (D-115 addendum, 2026-08-16): every `booking.created` re-runs the reminder
// scan so a class booked between two hourly ticks still gets its 1h/15m legs on
// time. The scan itself is covered in tests/notifications/reminder-scan.test.ts
// ("run at booking creation"); this pins the wiring — the trigger event, the id,
// and that the single step hands the real prisma + enqueue to
// scanAndScheduleNextWake, exactly as on-reminder-due.ts and the cron do.
// createFunction is mocked to hand back both the config and the raw handler.

const h = vi.hoisted(() => ({
  store: {
    config: null as { id?: string; retries?: number; triggers?: unknown[] } | null,
    handler: null as ((ctx: unknown) => Promise<unknown>) | null,
  },
  prisma: { booking: {} },
  enqueue: vi.fn(async () => {}),
  scanAndScheduleNextWake: vi.fn(async () => ({
    scanned: 0,
    due: 0,
    sent: 0,
    materialsDue: 0,
    materialsSent: 0,
    nextFireAt: null,
    wakeScheduledFor: null,
  })),
}));

vi.mock("@/lib/inngest/client", () => ({
  inngest: {
    createFunction: (
      cfg: { id?: string; retries?: number; triggers?: unknown[] },
      fn: (ctx: unknown) => Promise<unknown>,
    ) => ((h.store.config = cfg), (h.store.handler = fn), {}),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/jobs/enqueue", () => ({ enqueue: h.enqueue }));
vi.mock("@/lib/notifications/reminder-scan", () => ({
  scanAndScheduleNextWake: h.scanAndScheduleNextWake,
}));

await import("@/lib/inngest/functions/on-booking-created");

beforeEach(() => vi.clearAllMocks());

describe("on-booking-created", () => {
  it("is triggered by booking.created, and only that", () => {
    expect(h.store.config).not.toBeNull();
    expect(h.store.config!.id).toBe("on-booking-created");
    expect(h.store.config!.triggers).toEqual([{ event: "booking.created" }]);
    expect(h.store.config!.retries).toBe(1);
  });

  it("re-runs the reminder scan with the real prisma + enqueue in its one step", async () => {
    const stepNames: string[] = [];
    const step = {
      run: async (name: string, fn: () => unknown) => {
        stepNames.push(name);
        return fn();
      },
    };
    const event = {
      data: {
        bookingId: "b1",
        teacherId: "t1",
        studentId: "s1",
        packageId: "p1",
        scheduledStart: "2026-07-10T10:50:00.000Z",
      },
    };

    await h.store.handler!({ event, step });

    expect(stepNames).toEqual(["scan-due-reminders"]);
    expect(h.scanAndScheduleNextWake).toHaveBeenCalledTimes(1);
    // The scan takes the same deps the cron and the wake handler pass — no
    // `now`, no `limit`, and (deliberately) nothing from the event: the scan
    // re-derives everything from the live rows, so the payload is not trusted.
    expect(h.scanAndScheduleNextWake).toHaveBeenCalledWith({
      prisma: h.prisma,
      enqueue: h.enqueue,
    });
  });
});
