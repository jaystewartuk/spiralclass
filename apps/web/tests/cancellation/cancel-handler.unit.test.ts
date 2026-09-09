import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleStudentCancel,
  handleTeacherCancel,
  type CancelDeps,
  type CancelEventEmitter,
} from "@/lib/cancellation/cancel-handler";

/**
 * The cancellation policy engine: who gets their class back, and who does not.
 *
 * THE RULE, in one paragraph. A class is charged against the package when it is
 * BOOKED, not when it is taught — the codebase calls that ledger "Model B", and
 * every assertion below turns on it. A student cancelling 24 hours or more
 * ahead gets the class back (`classesUsed` drops) and spends one unit of a
 * pooled schedule-change budget. Inside 24 hours the class is forfeit: it stays
 * counted, and the cancel is never refused, because a student may always cancel
 * — they simply do not get the class back. A teacher cancelling always refunds,
 * whatever the clock says, and is never blocked by the budget.
 *
 * WHY THE BUDGET IS POOLED with reschedule, which is the subtle half: without
 * pooling, a student could cancel at ≥24h for a refund, rebook, and repeat —
 * out-running a reschedule cap that only counted reschedules.
 * `docs/features/scheduling-booking.md` is canonical for all of it.
 *
 * WHY AN IN-MEMORY PRISMA FAKE rather than the real-Postgres harness that also
 * exists (`*.integration.test.ts`, heavy tier). Money and quota move inside one
 * interactive transaction, and what these cases assert is its SHAPE — that a
 * refused cancel mutates nothing, that a budget lost to a concurrent writer
 * rolls the booking flip back with it, that the post-commit event fan-out
 * survives one emitter throwing. A fake makes those observable and lets a
 * concurrent writer be scripted deterministically; a real database makes them
 * slow and the race unreproducible. The tenancy filters are asserted here too,
 * because a missing `where teacherId` is the defect this product cannot afford
 * and it is visible in the query the fake receives.
 *
 * The clock is pinned: several cases sit either side of a 24-hour boundary and
 * would otherwise change meaning when CI runs near midnight.
 */

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_STUDENT_ID = "33333333-3333-4333-8333-333333333333";
const PACKAGE_ID = "44444444-4444-4444-8444-444444444444";
const BOOKING_ID = "55555555-5555-4555-8555-555555555555";

type BookingRow = {
  id: string;
  teacherId: string;
  studentId: string;
  packageId: string;
  status: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  /**
   * Written by the handler, not by `freshState` — a refunding cancel sets this
   * false to stop the row counting against the package, and a teacher cancel
   * clears `completedAt` so a class already auto-completed can still be
   * forgiven. Declared here so the assertions read the fake's real shape rather
   * than casting through `any`.
   */
  countsAgainstPackage?: boolean;
  completedAt?: Date | null;
};
type PackageRow = {
  id: string;
  teacherId: string;
  studentId: string;
  classesUsed: number;
  classesTotal: number;
  scheduleChangesUsed: number;
};
type TeacherRow = {
  id: string;
  timezone: string;
};
type NotificationRow = {
  id: string;
  teacherId: string;
  recipientType: string;
  recipientId: string;
  bookingId: string | null;
  templateName: string;
  status: string;
};
type OverrideRow = {
  id: string;
  teacherId: string;
  targetType: string;
  targetId: string;
  action: string;
  reason: string;
  beforeJson: unknown;
  afterJson: unknown;
};

type FakeState = {
  bookings: Map<string, BookingRow>;
  packages: Map<string, PackageRow>;
  teachers: Map<string, TeacherRow>;
  notifications: NotificationRow[];
  overrides: OverrideRow[];
};

function freshState(overrides?: {
  bookingStatus?: string;
  scheduledStart?: Date;
  classesUsed?: number;
  scheduleChangesUsed?: number;
}): FakeState {
  const start = overrides?.scheduledStart ?? new Date("2026-05-01T18:00:00Z");
  return {
    bookings: new Map([
      [
        BOOKING_ID,
        {
          id: BOOKING_ID,
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          packageId: PACKAGE_ID,
          status: overrides?.bookingStatus ?? "scheduled",
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 50 * 60_000),
        },
      ],
    ]),
    packages: new Map([
      [
        PACKAGE_ID,
        {
          id: PACKAGE_ID,
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          classesUsed: overrides?.classesUsed ?? 2,
          classesTotal: 10,
          scheduleChangesUsed: overrides?.scheduleChangesUsed ?? 0,
        },
      ],
    ]),
    teachers: new Map([
      [
        TEACHER_ID,
        {
          id: TEACHER_ID,
          timezone: "America/Mexico_City",
        },
      ],
    ]),
    notifications: [],
    overrides: [],
  };
}

function buildDeps(state: FakeState): {
  deps: CancelDeps;
  emitted: Array<{ name: string; data: unknown }>;
} {
  const emitted: Array<{ name: string; data: unknown }> = [];
  const emit: CancelEventEmitter = async (event) => {
    emitted.push(event);
  };

  const tx = {
    booking: {
      update: vi.fn(async ({ where, data }: any) => {
        const b = state.bookings.get(where.id);
        if (!b) throw new Error(`booking ${where.id} missing`);
        Object.assign(b, data);
        return b;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const b = state.bookings.get(where.id);
        if (!b) return { count: 0 };
        if (where.status && b.status !== where.status) return { count: 0 };
        Object.assign(b, data);
        return { count: 1 };
      }),
    },
    package: {
      update: vi.fn(async ({ where, data }: any) => {
        const p = state.packages.get(where.id);
        if (!p) throw new Error(`package ${where.id} missing`);
        if (data.classesUsed?.increment !== undefined) {
          p.classesUsed += data.classesUsed.increment;
        }
        if (data.classesUsed?.decrement !== undefined) {
          p.classesUsed -= data.classesUsed.decrement;
        }
        if (data.scheduleChangesUsed?.increment !== undefined) {
          p.scheduleChangesUsed += data.scheduleChangesUsed.increment;
        }
        return p;
      }),
      // Mirrors Prisma's conditional updateMany: applies (and reports count 1)
      // only when the row matches the WHERE — including the atomic budget guard
      // `scheduleChangesUsed: { lt }` and the floor guard `classesUsed: { gt }`
      // (packages_classes_used_bounds — Sentry 7590425327). A non-match
      // returns count 0 and mutates nothing, which is how both the
      // cross-booking budget race and an already-floored refund are detected.
      updateMany: vi.fn(async ({ where, data }: any) => {
        const p = state.packages.get(where.id);
        if (!p) return { count: 0 };
        if (
          where.scheduleChangesUsed?.lt !== undefined &&
          !(p.scheduleChangesUsed < where.scheduleChangesUsed.lt)
        ) {
          return { count: 0 };
        }
        if (where.classesUsed?.gt !== undefined && !(p.classesUsed > where.classesUsed.gt)) {
          return { count: 0 };
        }
        if (data.classesUsed?.decrement !== undefined) {
          p.classesUsed -= data.classesUsed.decrement;
        }
        if (data.scheduleChangesUsed?.increment !== undefined) {
          p.scheduleChangesUsed += data.scheduleChangesUsed.increment;
        }
        return { count: 1 };
      }),
    },
    notification: {
      create: vi.fn(async ({ data, select }: any) => {
        const id = `notif-${state.notifications.length + 1}`;
        state.notifications.push({
          id,
          teacherId: data.teacherId,
          recipientType: data.recipientType,
          recipientId: data.recipientId,
          bookingId: data.bookingId ?? null,
          templateName: data.templateName,
          status: data.status,
        });
        return select?.id ? { id } : { id, ...data };
      }),
    },
    override: {
      create: vi.fn(async ({ data }: any) => {
        const row: OverrideRow = {
          id: `override-${state.overrides.length + 1}`,
          teacherId: data.teacherId,
          targetType: data.targetType,
          targetId: data.targetId,
          action: data.action,
          reason: data.reason,
          beforeJson: data.beforeJson,
          afterJson: data.afterJson,
        };
        state.overrides.push(row);
        return row;
      }),
    },
  };

  const prisma = {
    booking: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const b of state.bookings.values()) {
          if (b.id !== where.id) continue;
          if (where.studentId) {
            // Identity-set lookups arrive as { in: [...] } (studentIdentityIds).
            const wanted = where.studentId.in ?? [where.studentId];
            if (!wanted.includes(b.studentId)) continue;
          }
          if (where.teacherId && b.teacherId !== where.teacherId) continue;
          // The student-cancel handler selects the package's budget fields.
          const pkg = state.packages.get(b.packageId);
          return {
            ...b,
            package: pkg
              ? {
                  classesTotal: pkg.classesTotal,
                  scheduleChangesUsed: pkg.scheduleChangesUsed,
                }
              : null,
          };
        }
        return null;
      }),
      update: tx.booking.update,
    },
    package: tx.package,
    notification: tx.notification,
    override: tx.override,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as CancelDeps["prisma"];

  return { deps: { prisma, emit }, emitted };
}

// The 24h cancellation-window classification compares a booking's scheduled
// start against the handler's own `new Date()`. The cases below build their
// scheduled-start times from `Date.now() + N`, so pin a fixed clock (Date only —
// setTimeout stays real, no async-hang risk) so the test's clock and the
// handler's clock are the SAME instant. Today the 3h/72h offsets clear the 24h
// cutoff by a wide margin, but pinning keeps the suite hermetic and boundary-
// stable if a future case is added closer to the cutoff or CI runs near midnight.
const FIXED_NOW = new Date("2026-06-15T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleStudentCancel", () => {
  let state: FakeState;

  beforeEach(() => {
    const far = new Date(Date.now() + 72 * 3600_000);
    state = freshState({ scheduledStart: far });
  });

  it("≥24h cancel: refunds the committed class (classes_used -= 1) + cancel_gte24h_with_reschedule enqueued + booking → canceled_by_student", async () => {
    const { deps, emitted } = buildDeps(state);

    const outcome = await handleStudentCancel(deps, {
      bookingId: BOOKING_ID,
      studentIds: [STUDENT_ID],
    });

    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();
    expect(outcome.timing).toBe("gte24h");

    // Model B: a ≥24h cancel releases the slot it held — classes_used drops
    // and the booking stops counting against the package.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(1);
    // ...and it spends one unit of the pooled schedule-change budget (the same
    // budget reschedule draws from), so cancel→rebook can't out-run the cap.
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(1);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_student");
    expect(state.bookings.get(BOOKING_ID)?.countsAgainstPackage).toBe(false);
    // Two notifications, not one: the student is told, and the teacher is
    // told, because a class vanishing from her calendar with no message is how
    // she finds out by noticing.
    expect(state.notifications).toHaveLength(2);
    expect(state.notifications[0].templateName).toBe("cancel_gte24h_with_reschedule");
    expect(state.notifications[0].status).toBe("queued");
    expect(state.notifications[1].templateName).toBe("cancel_gte24h_teacher");
    expect(state.notifications[1].recipientType).toBe("teacher");

    // Post-commit events: 2× notification.queued (student + teacher), then booking.canceled.
    expect(emitted.map((e) => e.name)).toEqual([
      "notification.queued",
      "notification.queued",
      "booking.canceled",
    ]);
  });

  it("a failing notification.queued emit still lets booking.canceled fire (decoupled fan-out)", async () => {
    // Regression: the sleeper-cancelling booking.canceled event must not be
    // skipped just because a notification trigger emit threw — a queued
    // notification is recoverable by the dispatcher's polling, but the
    // reminder/auto-complete sleepers would keep firing against a canceled row.
    const { deps } = buildDeps(state);
    const seen: string[] = [];
    deps.emit = async (event) => {
      seen.push(event.name);
      if (event.name === "notification.queued") throw new Error("inngest down");
    };

    const outcome = await handleStudentCancel(deps, {
      bookingId: BOOKING_ID,
      studentIds: [STUDENT_ID],
    });

    expect(outcome.code).toBe("ok");
    // The first notification emit threw, but booking.canceled was still emitted
    // from its own try block.
    expect(seen).toContain("booking.canceled");
    // The DB mutations committed regardless — the emit is post-commit.
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_student");
  });

  it("<24h cancel: classes_used += 1 + cancel_lt24h enqueued", async () => {
    const near = new Date(Date.now() + 3 * 3600_000);
    state = freshState({ scheduledStart: near });
    const { deps, emitted } = buildDeps(state);

    const outcome = await handleStudentCancel(deps, {
      bookingId: BOOKING_ID,
      studentIds: [STUDENT_ID],
    });

    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();
    expect(outcome.timing).toBe("lt24h");

    // Model B: the class was committed at booking and a <24h cancel keeps it
    // committed (the penalty) — classes_used is unchanged here.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
    // A forfeit (<24h) is not a "schedule change" — the budget is untouched.
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(0);
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_student");
    expect(state.notifications[0].templateName).toBe("cancel_lt24h");
    expect(state.notifications[1].templateName).toBe("cancel_lt24h_teacher");
    // 2× notification.queued (student + teacher) + booking.canceled = 3.
    expect(emitted).toHaveLength(3);
  });

  it("returns not-found when the booking belongs to a different student, rather than leaking that it exists", async () => {
    const { deps, emitted } = buildDeps(state);

    const outcome = await handleStudentCancel(deps, {
      bookingId: BOOKING_ID,
      studentIds: [OTHER_STUDENT_ID],
    });

    expect(outcome.code).toBe("not-found");
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("scheduled");
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
    expect(state.notifications).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("returns wrong-status when the booking is already canceled (no double-refund)", async () => {
    state = freshState({ bookingStatus: "canceled_by_student" });
    const { deps } = buildDeps(state);

    const outcome = await handleStudentCancel(deps, {
      bookingId: BOOKING_ID,
      studentIds: [STUDENT_ID],
    });

    expect(outcome.code).toBe("wrong-status");
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
    expect(state.notifications).toHaveLength(0);
  });

  it("≥24h cancel with the schedule-change budget spent: blocked, nothing mutates", async () => {
    // budget = classesTotal (10); used = 10 → exhausted. The refundable cancel
    // is the cancel→rebook free-move primitive, so it's refused rather than
    // handing the class back for free.
    const far = new Date(Date.now() + 72 * 3600_000);
    state = freshState({ scheduledStart: far, scheduleChangesUsed: 10 });
    const { deps, emitted } = buildDeps(state);

    const outcome = await handleStudentCancel(deps, {
      bookingId: BOOKING_ID,
      studentIds: [STUDENT_ID],
    });

    expect(outcome.code).toBe("schedule-changes-exhausted");
    // No refund, no status change, no budget charge, no notifications.
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("scheduled");
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(10);
    expect(state.notifications).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("≥24h cancel that loses the budget race mid-transaction → schedule-changes-exhausted, nothing overshoots", async () => {
    // Cross-booking race: a concurrent ≥24h cancel of a *different* booking in
    // this package already spent the last pooled unit (stored scheduleChangesUsed
    // = cap), but our out-of-tx read still saw budget available (used 9 < 10) —
    // the exact window decideStudentCancel runs in. The atomic guarded claim must
    // then match no row and refuse the cancel rather than overshoot the cap.
    const far = new Date(Date.now() + 72 * 3600_000);
    state = freshState({ scheduledStart: far, scheduleChangesUsed: 10 });
    const { deps, emitted } = buildDeps(state);
    // Stale read: reports the package as still having a free unit.
    //
    // Cast through the method's own type rather than `any`. The handler reads
    // seven fields; Prisma's `findFirst` signature is generic over the whole
    // model and its includes, so writing the honest return type here would be
    // more generics than test. The cast is narrow and named, and a change to
    // what the handler reads still fails the assertions below.
    deps.prisma.booking.findFirst = vi.fn(async () => ({
      id: BOOKING_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      status: "scheduled",
      scheduledStart: far,
      package: { classesTotal: 10, scheduleChangesUsed: 9 },
    })) as unknown as typeof deps.prisma.booking.findFirst;

    const outcome = await handleStudentCancel(deps, {
      bookingId: BOOKING_ID,
      studentIds: [STUDENT_ID],
    });

    expect(outcome.code).toBe("schedule-changes-exhausted");
    // The guarded claim matched no row: no refund, no budget overshoot, no
    // notifications enqueued (the throw fires before enqueue). Real Postgres also
    // rolls the booking flip back — the integration suite covers that; the
    // in-memory fake can't replay transaction rollback.
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(10);
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
    expect(state.notifications).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("<24h cancel still works when the budget is spent (forfeit is always allowed)", async () => {
    const near = new Date(Date.now() + 3 * 3600_000);
    state = freshState({ scheduledStart: near, scheduleChangesUsed: 10 });
    const { deps } = buildDeps(state);

    const outcome = await handleStudentCancel(deps, {
      bookingId: BOOKING_ID,
      studentIds: [STUDENT_ID],
    });

    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();
    expect(outcome.timing).toBe("lt24h");
    // Forfeit: class stays committed (penalty), budget untouched.
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_student");
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(10);
  });

  // Regression for Sentry 7590425327: PrismaClientUnknownRequestError /
  // packages_classes_used_bounds CHECK violation. classes_used should never
  // be able to go negative — it's COUNT of committed bookings — but if the
  // invariant is already wrong upstream (e.g. from an earlier bug), the
  // refund decrement must not crash with a raw 500. The cancel itself still
  // succeeds; only the impossible decrement is skipped.
  it("≥24h cancel with classes_used already at 0: cancel still succeeds, decrement is skipped", async () => {
    const far = new Date(Date.now() + 72 * 3600_000);
    state = freshState({ scheduledStart: far, classesUsed: 0 });
    const { deps, emitted } = buildDeps(state);

    const outcome = await handleStudentCancel(deps, {
      bookingId: BOOKING_ID,
      studentIds: [STUDENT_ID],
    });

    expect(outcome.code).toBe("ok");
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_student");
    // Never negative — the floor-guarded updateMany matched no row, so the
    // decrement was skipped rather than underflowing.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(0);
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(1);
    expect(emitted.map((e) => e.name)).toEqual([
      "notification.queued",
      "notification.queued",
      "booking.canceled",
    ]);
  });
});

describe("handleTeacherCancel", () => {
  let state: FakeState;

  beforeEach(() => {
    const far = new Date(Date.now() + 72 * 3600_000);
    state = freshState({ scheduledStart: far });
  });

  it("refunds the committed class, logs an override with reason, enqueues teacher_cancel", async () => {
    const { deps, emitted } = buildDeps(state);

    const outcome = await handleTeacherCancel(deps, {
      bookingId: BOOKING_ID,
      teacherId: TEACHER_ID,
      reason: "Estoy enferma, disculpa.",
    });

    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();

    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_teacher");
    // Model B: teacher cancel releases the committed slot.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(1);
    expect(state.bookings.get(BOOKING_ID)?.countsAgainstPackage).toBe(false);

    expect(state.overrides).toHaveLength(1);
    const override = state.overrides[0];
    expect(override.action).toBe("teacher_cancel");
    expect(override.targetType).toBe("booking");
    expect(override.targetId).toBe(BOOKING_ID);
    expect(override.reason).toBe("Estoy enferma, disculpa.");
    expect((override.afterJson as { status: string }).status).toBe("canceled_by_teacher");

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].templateName).toBe("teacher_cancel");
    expect(emitted.map((e) => e.name)).toEqual(["notification.queued", "booking.canceled"]);
  });

  it("forgives a past completed class: refunds, → canceled_by_teacher, teacher_cancel override", async () => {
    // A class that already auto-completed at its end time, which the teacher
    // now decides to return to the package (the student had a valid reason).
    state = freshState({ bookingStatus: "completed" });
    state.bookings.get(BOOKING_ID)!.completedAt = new Date();
    const { deps, emitted } = buildDeps(state);

    const outcome = await handleTeacherCancel(deps, {
      bookingId: BOOKING_ID,
      teacherId: TEACHER_ID,
      reason: "La alumna estuvo enferma, le devuelvo la clase.",
    });

    expect(outcome.code).toBe("ok");
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_teacher");
    // The committed class is refunded back into the package.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(1);
    expect(state.bookings.get(BOOKING_ID)?.countsAgainstPackage).toBe(false);
    // The auto-complete stamp is cleared — it's no longer a delivered class.
    expect(state.bookings.get(BOOKING_ID)?.completedAt).toBeNull();
    expect(state.overrides[0].action).toBe("teacher_cancel");
    expect((state.overrides[0].beforeJson as { status: string }).status).toBe("completed");
    expect(state.notifications[0].templateName).toBe("teacher_cancel");
    expect(emitted.map((e) => e.name)).toEqual(["notification.queued", "booking.canceled"]);
  });

  it("rejects when the booking is already off the calendar (wrong-status, no double-refund)", async () => {
    state = freshState({ bookingStatus: "canceled_by_teacher" });
    const { deps } = buildDeps(state);

    const outcome = await handleTeacherCancel(deps, {
      bookingId: BOOKING_ID,
      teacherId: TEACHER_ID,
      reason: "Doble click",
    });

    expect(outcome.code).toBe("wrong-status");
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
    expect(state.overrides).toHaveLength(0);
  });

  it("rejects teacher-cancel across tenancy (wrong teacherId → not-found)", async () => {
    const { deps } = buildDeps(state);

    const outcome = await handleTeacherCancel(deps, {
      bookingId: BOOKING_ID,
      teacherId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      reason: "ruta inválida",
    });

    expect(outcome.code).toBe("not-found");
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("scheduled");
    expect(state.overrides).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });

  // Regression for Sentry 7590425327 — see the matching test in
  // handleStudentCancel above for the full context.
  it("with classes_used already at 0: teacher cancel still succeeds, decrement is skipped", async () => {
    const far = new Date(Date.now() + 72 * 3600_000);
    state = freshState({ scheduledStart: far, classesUsed: 0 });
    const { deps, emitted } = buildDeps(state);

    const outcome = await handleTeacherCancel(deps, {
      bookingId: BOOKING_ID,
      teacherId: TEACHER_ID,
      reason: "Emergencia familiar",
    });

    expect(outcome.code).toBe("ok");
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("canceled_by_teacher");
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(0);
    expect(state.overrides).toHaveLength(1);
    expect(emitted.map((e) => e.name)).toEqual(["notification.queued", "booking.canceled"]);
  });
});
