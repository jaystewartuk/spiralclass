import { beforeEach, describe, expect, it, vi } from "vitest";

// The booking-buffer race (bug-hunt audit, medium) is now closed at the DB
// level: `bookings_no_overlap_buffered` (migration 20260703020000) is a GiST
// EXCLUDE constraint over [scheduled_start, buffered_end) per teacher, scoped
// to scheduled rows. `buffered_end` is derived by a DB trigger (migration
// 20260703010000) from `buffer_min_snapshot` — it can't be fooled by a
// concurrent transaction's uncommitted row the way an app-level re-check (the
// previous approach) could — that's what makes it race-proof. This test pins
// the two things bookPackageSlot must do to cooperate with that constraint:
//   1. snapshot the teacher's CURRENT buffer_min onto every inserted row
//   2. map the constraint's Postgres error to the friendly slot-taken outcome

const START = new Date("2026-07-01T15:00:00.000Z");

vi.mock("@/lib/slots", () => ({
  generateSlots: () => [{ startUtc: START }],
}));
vi.mock("@/lib/calendar/google/busy", () => ({
  loadGoogleBusyBlocks: async () => [],
}));
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueBookingConfirmation: async () => "notif-1",
  enqueueBookingCreatedTeacher: async () => "notif-2",
}));
// Credit is always available and always claims package pkg1.
vi.mock("@/lib/booking/credit-ledger", () => ({
  checkCreditAvailability: async () => ({ code: "ok" }),
  claimNextCredit: async () => ({ packageId: "pkg1", studentId: "s1", expiresAt: null }),
}));

const { bookPackageSlot } = await import("@/lib/booking/book-package-slot");

function makeDeps(opts: { throwOnCreate?: unknown } = {}) {
  const created: Array<{ scheduledStart: Date; scheduledEnd: Date; bufferMinSnapshot: number }> =
    [];
  const tx = {
    booking: {
      findMany: async () => [],
      create: async ({
        data,
      }: {
        data: { scheduledStart: Date; scheduledEnd: Date; bufferMinSnapshot: number };
      }) => {
        if (opts.throwOnCreate) throw opts.throwOnCreate;
        created.push({
          scheduledStart: data.scheduledStart,
          scheduledEnd: data.scheduledEnd,
          bufferMinSnapshot: data.bufferMinSnapshot,
        });
        return { id: "bk-new" };
      },
    },
    override: { create: async () => ({}) },
  };
  const prisma = {
    availabilityRule: { findMany: async () => [] },
    blockedDate: { findMany: async () => [] },
    googleBusyInterval: {},
    booking: tx.booking,
    package: { fields: { classesTotal: "classesTotal" } },
    override: tx.override,
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx),
  };
  return { deps: { prisma: prisma as never }, created };
}

const PKG = {
  id: "pkg1",
  teacherId: "t1",
  studentId: "s1",
  classesUsed: 0,
  classesTotal: 10,
  classDurationMin: 50,
  expiresAt: null,
};
const TEACHER = {
  timezone: "America/Mexico_City",
  bufferMin: 10,
  minAdvanceH: 0,
  maxAdvanceDays: 30,
};

function input(over: Record<string, unknown> = {}) {
  return {
    pkg: PKG,
    teacher: TEACHER,
    startUtc: START,
    now: new Date("2026-06-30T00:00:00Z"),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("bookPackageSlot ↔ bookings_no_overlap_buffered", () => {
  it("snapshots the teacher's current buffer_min onto the inserted row", async () => {
    const { deps, created } = makeDeps();
    const res = await bookPackageSlot(deps, input());
    expect(res.code).toBe("ok");
    expect(created).toHaveLength(1);
    expect(created[0].bufferMinSnapshot).toBe(10);
  });

  it("snapshots a different teacher's buffer_min correctly (not hard-coded)", async () => {
    const { deps, created } = makeDeps();
    const res = await bookPackageSlot(deps, input({ teacher: { ...TEACHER, bufferMin: 25 } }));
    expect(res.code).toBe("ok");
    expect(created[0].bufferMinSnapshot).toBe(25);
  });

  it("a failing notification.queued emit still lets booking.created fire (decoupled fan-out)", async () => {
    // Regression: booking.created schedules this booking's reminders +
    // auto-complete. A notification trigger emit throwing must not abort it —
    // the notification row is recoverable by the dispatcher's polling, but the
    // reminder sleepers have no such backstop.
    const { deps, created } = makeDeps();
    const seen: string[] = [];
    const emit = async (event: { name: string }) => {
      seen.push(event.name);
      if (event.name === "notification.queued") throw new Error("inngest down");
    };
    const depsWithEmit = { ...deps, emit } as Parameters<typeof bookPackageSlot>[0];

    const res = await bookPackageSlot(depsWithEmit, input({ notifyTeacher: true }));

    expect(res.code).toBe("ok");
    expect(created).toHaveLength(1);
    // The notification emit threw, but booking.created still fired from its own
    // try block.
    expect(seen).toContain("booking.created");
  });

  it("maps a bookings_no_overlap_buffered exclusion violation to slot-taken", async () => {
    // Simulates the DB constraint firing under real concurrency — something an
    // app-level pre-check can never fully replicate, which is why the fix
    // moved enforcement into Postgres.
    const constraintError = Object.assign(
      new Error(
        'insert or update on table "bookings" violates exclusion constraint "bookings_no_overlap_buffered"',
      ),
      { code: undefined },
    );
    const { deps, created } = makeDeps({ throwOnCreate: constraintError });
    const res = await bookPackageSlot(deps, input());
    expect(res.code).toBe("slot-taken");
    expect(created).toHaveLength(0);
  });
});
