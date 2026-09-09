import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyBookingsInBlockedRange } from "@/lib/cancellation/blocked-date-collision";
import type { CancelDeps, CancelEventEmitter } from "@/lib/cancellation/cancel-handler";

// Blocked dates — when a teacher creates a BlockedDate, scheduled bookings inside
// the new range get teacher-cancelled (class restored, override logged,
// `teacher_cancel` notification queued). The helper itself is a thin loop
// around `handleTeacherCancel`, so the focus here is the range query +
// the per-booking outcome filtering.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "99999999-9999-4999-8999-999999999999";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const PACKAGE_ID = "44444444-4444-4444-8444-444444444444";

type BookingRow = {
  id: string;
  teacherId: string;
  studentId: string;
  packageId: string;
  status: string;
  scheduledStart: Date;
  scheduledEnd: Date;
};
type TeacherRow = {
  id: string;
  timezone: string;
};
type NotificationRow = {
  id: string;
  teacherId: string;
  templateName: string;
  bookingId: string | null;
};
type OverrideRow = {
  teacherId: string;
  targetId: string;
  action: string;
  reason: string;
};
type State = {
  bookings: Map<string, BookingRow>;
  teachers: Map<string, TeacherRow>;
  notifications: NotificationRow[];
  overrides: OverrideRow[];
};

function freshState(): State {
  return {
    bookings: new Map(),
    teachers: new Map([
      [TEACHER_ID, { id: TEACHER_ID, timezone: "America/Mexico_City" }],
      [OTHER_TEACHER_ID, { id: OTHER_TEACHER_ID, timezone: "UTC" }],
    ]),
    notifications: [],
    overrides: [],
  };
}

function addBooking(state: State, row: Partial<BookingRow> & { id: string; scheduledStart: Date }) {
  const start = row.scheduledStart;
  state.bookings.set(row.id, {
    id: row.id,
    teacherId: row.teacherId ?? TEACHER_ID,
    studentId: row.studentId ?? STUDENT_ID,
    packageId: row.packageId ?? PACKAGE_ID,
    status: row.status ?? "scheduled",
    scheduledStart: start,
    scheduledEnd: row.scheduledEnd ?? new Date(start.getTime() + 50 * 60_000),
  });
}

function buildDeps(state: State): {
  deps: CancelDeps;
  emitted: Array<{ name: string; data: unknown }>;
} {
  const emitted: Array<{ name: string; data: unknown }> = [];
  const emit: CancelEventEmitter = async (event) => {
    emitted.push(event);
  };

  const tx = {
    booking: {
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<BookingRow> }) => {
          const b = state.bookings.get(where.id);
          if (!b) throw new Error(`booking ${where.id} missing`);
          Object.assign(b, data);
          return b;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: string };
          data: Partial<BookingRow>;
        }) => {
          const b = state.bookings.get(where.id);
          if (!b) return { count: 0 };
          if (where.status && b.status !== where.status) return { count: 0 };
          Object.assign(b, data);
          return { count: 1 };
        },
      ),
    },
    package: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    notification: {
      create: vi.fn(
        async ({
          data,
          select,
        }: {
          data: { teacherId: string; templateName: string; bookingId: string | null };
          select?: { id?: boolean };
        }) => {
          const id = `notif-${state.notifications.length + 1}`;
          state.notifications.push({
            id,
            teacherId: data.teacherId,
            templateName: data.templateName,
            bookingId: data.bookingId ?? null,
          });
          return select?.id ? { id } : { id, ...data };
        },
      ),
    },
    override: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: { teacherId: string; targetId: string; action: string; reason: string };
        }) => {
          const row: OverrideRow = {
            teacherId: data.teacherId,
            targetId: data.targetId,
            action: data.action,
            reason: data.reason,
          };
          state.overrides.push(row);
          return row;
        },
      ),
    },
  };

  const prisma = {
    booking: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; teacherId?: string } }) => {
        const b = state.bookings.get(where.id);
        if (!b) return null;
        if (where.teacherId && b.teacherId !== where.teacherId) return null;
        return { ...b };
      }),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            teacherId: string;
            status: string;
            scheduledStart: { lt: Date };
            scheduledEnd: { gt: Date };
          };
        }) => {
          const out: Array<{ id: string }> = [];
          for (const b of state.bookings.values()) {
            if (b.teacherId !== where.teacherId) continue;
            if (b.status !== where.status) continue;
            // True interval overlap: starts before the block ends AND ends
            // after the block starts.
            if (!(b.scheduledStart < where.scheduledStart.lt)) continue;
            if (!(b.scheduledEnd > where.scheduledEnd.gt)) continue;
            out.push({ id: b.id });
          }
          return out;
        },
      ),
      update: tx.booking.update,
    },
    package: tx.package,
    notification: tx.notification,
    override: tx.override,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as CancelDeps["prisma"];

  return { deps: { prisma, emit }, emitted };
}

describe("notifyBookingsInBlockedRange", () => {
  // Block covers the full local day 2026-05-15 in America/Mexico_City (UTC-6).
  // 00:00:00 local = 06:00:00 UTC; 23:59:59.999 local = 05:59:59.999 next day UTC.
  const startsAt = new Date("2026-05-15T06:00:00Z");
  const endsAt = new Date("2026-05-16T05:59:59.999Z");

  let state: State;

  beforeEach(() => {
    state = freshState();
  });

  it("returns 0 + emits nothing when no scheduled bookings overlap", async () => {
    addBooking(state, {
      id: "before-block",
      scheduledStart: new Date("2026-05-14T18:00:00Z"),
    });
    addBooking(state, {
      id: "after-block",
      scheduledStart: new Date("2026-05-16T18:00:00Z"),
    });

    const { deps, emitted } = buildDeps(state);
    const result = await notifyBookingsInBlockedRange(deps, {
      teacherId: TEACHER_ID,
      startsAt,
      endsAt,
      reason: "Vacaciones",
    });

    expect(result.canceled).toBe(0);
    expect(result.bookingIds).toEqual([]);
    expect(emitted).toHaveLength(0);
    expect(state.bookings.get("before-block")?.status).toBe("scheduled");
    expect(state.bookings.get("after-block")?.status).toBe("scheduled");
  });

  it("teacher-cancels every scheduled booking inside the block + queues teacher_cancel + logs override per booking", async () => {
    addBooking(state, {
      id: "morning",
      scheduledStart: new Date("2026-05-15T15:00:00Z"), // 09:00 local
    });
    addBooking(state, {
      id: "evening",
      scheduledStart: new Date("2026-05-15T23:30:00Z"), // 17:30 local
    });
    addBooking(state, {
      id: "outside",
      scheduledStart: new Date("2026-05-17T18:00:00Z"),
    });

    const { deps, emitted } = buildDeps(state);
    const result = await notifyBookingsInBlockedRange(deps, {
      teacherId: TEACHER_ID,
      startsAt,
      endsAt,
      reason: "Vacaciones",
    });

    expect(result.canceled).toBe(2);
    expect(result.bookingIds).toEqual(["morning", "evening"]);
    expect(state.bookings.get("morning")?.status).toBe("canceled_by_teacher");
    expect(state.bookings.get("evening")?.status).toBe("canceled_by_teacher");
    expect(state.bookings.get("outside")?.status).toBe("scheduled");

    expect(state.notifications).toHaveLength(2);
    expect(state.notifications.every((n) => n.templateName === "teacher_cancel")).toBe(true);

    expect(state.overrides).toHaveLength(2);
    expect(state.overrides.every((o) => o.action === "teacher_cancel")).toBe(true);
    // Reason is composed with the prefix so the audit log explains why.
    expect(state.overrides.every((o) => o.reason === "Fecha bloqueada: Vacaciones")).toBe(true);

    // Each booking emits both the notification.queued and booking.canceled
    // events post-commit (4 total for 2 bookings).
    expect(emitted.filter((e) => e.name === "notification.queued")).toHaveLength(2);
    expect(emitted.filter((e) => e.name === "booking.canceled")).toHaveLength(2);
  });

  it("cancels every colliding booking across batch boundaries, preserving order", async () => {
    // 7 bookings > the internal concurrency batch size (5) — exercises the
    // multi-batch path and confirms results stay in collision order.
    const ids = Array.from({ length: 7 }, (_, i) => `b-${i}`);
    ids.forEach((id, i) => {
      addBooking(state, {
        id,
        // All within the block (15:00 UTC + i minutes), distinct starts.
        scheduledStart: new Date(`2026-05-15T15:0${i}:00Z`),
      });
    });

    const { deps, emitted } = buildDeps(state);
    const result = await notifyBookingsInBlockedRange(deps, {
      teacherId: TEACHER_ID,
      startsAt,
      endsAt,
      reason: "Vacaciones",
    });

    expect(result.canceled).toBe(7);
    expect(result.bookingIds).toEqual(ids);
    expect(ids.every((id) => state.bookings.get(id)?.status === "canceled_by_teacher")).toBe(true);
    expect(emitted.filter((e) => e.name === "booking.canceled")).toHaveLength(7);
  });

  it("uses a generic Spanish reason when the teacher didn't provide one", async () => {
    addBooking(state, {
      id: "in-range",
      scheduledStart: new Date("2026-05-15T18:00:00Z"),
    });
    const { deps } = buildDeps(state);
    await notifyBookingsInBlockedRange(deps, {
      teacherId: TEACHER_ID,
      startsAt,
      endsAt,
      reason: null,
    });
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0].reason).toBe("Fecha bloqueada en tu calendario");
  });

  it("skips bookings that aren't 'scheduled' (already-completed / canceled stay untouched)", async () => {
    addBooking(state, {
      id: "completed",
      scheduledStart: new Date("2026-05-15T18:00:00Z"),
      status: "completed",
    });
    addBooking(state, {
      id: "already-canceled",
      scheduledStart: new Date("2026-05-15T19:00:00Z"),
      status: "canceled_by_student",
    });
    const { deps, emitted } = buildDeps(state);
    const result = await notifyBookingsInBlockedRange(deps, {
      teacherId: TEACHER_ID,
      startsAt,
      endsAt,
      reason: "Festivo",
    });
    expect(result.canceled).toBe(0);
    expect(emitted).toHaveLength(0);
    expect(state.bookings.get("completed")?.status).toBe("completed");
    expect(state.bookings.get("already-canceled")?.status).toBe("canceled_by_student");
  });

  it("ignores other teachers' bookings inside the same time window (tenancy)", async () => {
    addBooking(state, {
      id: "mine",
      scheduledStart: new Date("2026-05-15T18:00:00Z"),
    });
    addBooking(state, {
      id: "theirs",
      scheduledStart: new Date("2026-05-15T19:00:00Z"),
      teacherId: OTHER_TEACHER_ID,
    });
    const { deps } = buildDeps(state);
    const result = await notifyBookingsInBlockedRange(deps, {
      teacherId: TEACHER_ID,
      startsAt,
      endsAt,
      reason: null,
    });
    expect(result.canceled).toBe(1);
    expect(result.bookingIds).toEqual(["mine"]);
    expect(state.bookings.get("theirs")?.status).toBe("scheduled");
  });
});
