import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  applyReschedule,
  type RescheduleDeps,
  type RescheduleEventEmitter,
} from "@/lib/cancellation/reschedule-handler";

// Covers the Slice-4-dependency shape: applyReschedule must insert the new
// booking, flip the old one to `rescheduled`, leave package quota alone,
// and emit a fresh booking.created so reminders / auto-complete sleepers
// re-fan. This is the invariant Slice 6 (monthly plans) will rely on when
// recurring slots start generating reschedules at 10× the current volume.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const PACKAGE_ID = "44444444-4444-4444-8444-444444444444";
const OLD_BOOKING_ID = "55555555-5555-4555-8555-555555555555";

type BookingRow = {
  id: string;
  teacherId: string;
  studentId: string;
  packageId: string;
  status: string;
  countsAgainstPackage?: boolean;
  scheduledStart: Date;
  scheduledEnd: Date;
  rescheduleOfBookingId: string | null;
  rescheduleCount: number;
};
type NotificationRow = {
  id: string;
  teacherId: string;
  recipientType: string;
  recipientId: string;
  bookingId: string | null;
  templateName: string;
  metadata: unknown;
  status: string;
};

type PackageRow = {
  id: string;
  scheduleChangesUsed: number;
  classesTotal: number;
};

type OverrideRow = {
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
  notifications: NotificationRow[];
  overrides: OverrideRow[];
  nextBookingId: { value: number };
};

const OLD_START = new Date("2026-05-04T18:00:00Z"); // Monday
const NEW_START = new Date("2026-05-07T20:00:00Z"); // Thursday same week
const NEW_END = new Date(NEW_START.getTime() + 50 * 60_000);

function freshState(): FakeState {
  return {
    bookings: new Map([
      [
        OLD_BOOKING_ID,
        {
          id: OLD_BOOKING_ID,
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          packageId: PACKAGE_ID,
          status: "scheduled",
          countsAgainstPackage: true,
          scheduledStart: OLD_START,
          scheduledEnd: new Date(OLD_START.getTime() + 50 * 60_000),
          rescheduleOfBookingId: null,
          rescheduleCount: 0,
        },
      ],
    ]),
    packages: new Map([[PACKAGE_ID, { id: PACKAGE_ID, scheduleChangesUsed: 0, classesTotal: 8 }]]),
    notifications: [],
    overrides: [],
    nextBookingId: { value: 1 },
  };
}

function buildDeps(
  state: FakeState,
  opts?: { throwOnCreate?: Prisma.PrismaClientKnownRequestError },
): {
  deps: RescheduleDeps;
  emitted: Array<{ name: string; data: unknown }>;
} {
  const emitted: Array<{ name: string; data: unknown }> = [];
  const emit: RescheduleEventEmitter = async (event) => {
    emitted.push(event);
  };

  const tx = {
    booking: {
      create: vi.fn(async ({ data }: any) => {
        if (opts?.throwOnCreate) throw opts.throwOnCreate;
        const id = `new-booking-${state.nextBookingId.value++}`;
        const row: BookingRow = {
          id,
          teacherId: data.teacherId,
          studentId: data.studentId,
          packageId: data.packageId,
          status: data.status,
          scheduledStart: data.scheduledStart,
          scheduledEnd: data.scheduledEnd,
          rescheduleOfBookingId: data.rescheduleOfBookingId,
          rescheduleCount: data.rescheduleCount,
        };
        state.bookings.set(id, row);
        return row;
      }),
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
      findUnique: vi.fn(async ({ where }: any) => state.packages.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const p = state.packages.get(where.id);
        if (!p) throw new Error(`package ${where.id} missing`);
        if (data.scheduleChangesUsed?.increment !== undefined) {
          p.scheduleChangesUsed += data.scheduleChangesUsed.increment;
        }
        return p;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const p = state.packages.get(where.id);
        if (!p) return { count: 0 };
        // Honor the `scheduleChangesUsed < budget` guard the handler applies.
        if (
          where.scheduleChangesUsed?.lt !== undefined &&
          !(p.scheduleChangesUsed < where.scheduleChangesUsed.lt)
        ) {
          return { count: 0 };
        }
        if (data.scheduleChangesUsed?.increment !== undefined) {
          p.scheduleChangesUsed += data.scheduleChangesUsed.increment;
        }
        return { count: 1 };
      }),
    },
    override: {
      create: vi.fn(async ({ data }: any) => {
        const row: OverrideRow = {
          teacherId: data.teacherId,
          targetType: data.targetType,
          targetId: data.targetId,
          action: data.action,
          reason: data.reason,
          beforeJson: data.beforeJson ?? null,
          afterJson: data.afterJson ?? null,
        };
        state.overrides.push(row);
        return { id: `override-${state.overrides.length}`, ...row };
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
          metadata: data.metadata ?? null,
          status: data.status,
        });
        return select?.id ? { id } : { id, ...data };
      }),
    },
  };

  const prisma = {
    booking: tx.booking,
    package: tx.package,
    notification: tx.notification,
    override: tx.override,
    // Model real transaction rollback: snapshot the mutable state before the
    // callback and restore it if the callback throws, so assertions about "the
    // whole tx rolls back on a conflict" are faithful regardless of the order
    // in which the handler mutates rows.
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const snapshot = {
        bookings: new Map([...state.bookings].map(([k, v]) => [k, { ...v }])),
        packages: new Map([...state.packages].map(([k, v]) => [k, { ...v }])),
        notifications: state.notifications.map((n) => ({ ...n })),
        overrides: state.overrides.map((o) => ({ ...o })),
        nextBookingId: state.nextBookingId.value,
      };
      try {
        return await fn(tx);
      } catch (err) {
        state.bookings = snapshot.bookings;
        state.packages = snapshot.packages;
        state.notifications.length = 0;
        state.notifications.push(...snapshot.notifications);
        state.overrides.length = 0;
        state.overrides.push(...snapshot.overrides);
        state.nextBookingId.value = snapshot.nextBookingId;
        throw err;
      }
    }),
  } as unknown as RescheduleDeps["prisma"];

  return { deps: { prisma, emit }, emitted };
}

describe("applyReschedule", () => {
  let state: FakeState;

  beforeEach(() => {
    state = freshState();
  });

  it("inserts the new booking, flips the old to `rescheduled`, and leaves package quota alone", async () => {
    const { deps } = buildDeps(state);

    const outcome = await applyReschedule(deps, {
      oldBookingId: OLD_BOOKING_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      oldScheduledStart: OLD_START,
      oldRescheduleCount: 0,
      newStartUtc: NEW_START,
      newEndUtc: NEW_END,
      bufferMin: 10,
    });

    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();

    // Old row short-circuits Slice 4 sleepers via the status change.
    expect(state.bookings.get(OLD_BOOKING_ID)?.status).toBe("rescheduled");
    // Model B: the old row releases its committed slot; the new row (created
    // counts_against_package = true) takes it over — net quota change zero.
    expect(state.bookings.get(OLD_BOOKING_ID)?.countsAgainstPackage).toBe(false);
    // A reschedule spends one unit of the package's pooled schedule-change
    // budget (the same budget a ≥24h cancel draws from).
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(1);

    const created = state.bookings.get(outcome.newBookingId);
    expect(created).toBeDefined();
    expect(created?.status).toBe("scheduled");
    expect(created?.scheduledStart).toEqual(NEW_START);
    expect(created?.scheduledEnd).toEqual(NEW_END);
    expect(created?.rescheduleOfBookingId).toBe(OLD_BOOKING_ID);
    // The per-package budget is what gates reschedules now (classify.ts);
    // rescheduleCount is kept only as a lineage/audit depth on the new row.
    expect(created?.rescheduleCount).toBe(1);
    expect(created?.packageId).toBe(PACKAGE_ID);
  });

  it("enqueues reschedule_confirm carrying the old start time in metadata", async () => {
    const { deps } = buildDeps(state);

    const outcome = await applyReschedule(deps, {
      oldBookingId: OLD_BOOKING_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      oldScheduledStart: OLD_START,
      oldRescheduleCount: 0,
      newStartUtc: NEW_START,
      newEndUtc: NEW_END,
      bufferMin: 10,
    });
    if (outcome.code !== "ok") throw new Error();

    // 2 notifications: student-facing reschedule_confirm + teacher mirror
    // (reschedule_confirm_teacher, audit P2 #10c).
    expect(state.notifications).toHaveLength(2);
    const notif = state.notifications[0];
    expect(notif.templateName).toBe("reschedule_confirm");
    expect(notif.bookingId).toBe(outcome.newBookingId);
    expect(notif.status).toBe("queued");
    expect((notif.metadata as { oldScheduledStart: string }).oldScheduledStart).toBe(
      OLD_START.toISOString(),
    );
    const teacherNotif = state.notifications[1];
    expect(teacherNotif.templateName).toBe("reschedule_confirm_teacher");
    expect(teacherNotif.recipientType).toBe("teacher");
    expect(teacherNotif.bookingId).toBe(outcome.newBookingId);
  });

  it("emits booking.created for the new row so Slice 4 sleepers re-fan against the new start", async () => {
    const { deps, emitted } = buildDeps(state);

    const outcome = await applyReschedule(deps, {
      oldBookingId: OLD_BOOKING_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      oldScheduledStart: OLD_START,
      oldRescheduleCount: 0,
      newStartUtc: NEW_START,
      newEndUtc: NEW_END,
      bufferMin: 10,
    });
    if (outcome.code !== "ok") throw new Error();

    // Four events, in order: 2× notification.queued (student + teacher
    // mirror, audit P2 #10c) → booking.rescheduled → booking.created.
    expect(emitted.map((e) => e.name)).toEqual([
      "notification.queued",
      "notification.queued",
      "booking.rescheduled",
      "booking.created",
    ]);

    // The booking.rescheduled event carries the OLD booking id (so listeners
    // on old-row sleepers can correlate) and the new start time.
    const rescheduled = emitted.find((e) => e.name === "booking.rescheduled");
    expect((rescheduled?.data as { bookingId: string }).bookingId).toBe(OLD_BOOKING_ID);
    expect((rescheduled?.data as { newScheduledStart: string }).newScheduledStart).toBe(
      NEW_START.toISOString(),
    );

    // The booking.created event carries the NEW booking id + new start so
    // Slice 4 can spawn fresh reminders / auto-complete sleepers against
    // the right row.
    const created = emitted.find((e) => e.name === "booking.created");
    const createdData = created?.data as {
      bookingId: string;
      teacherId: string;
      studentId: string;
      packageId: string;
      scheduledStart: string;
    };
    expect(createdData.bookingId).toBe(outcome.newBookingId);
    expect(createdData.teacherId).toBe(TEACHER_ID);
    expect(createdData.studentId).toBe(STUDENT_ID);
    expect(createdData.packageId).toBe(PACKAGE_ID);
    expect(createdData.scheduledStart).toBe(NEW_START.toISOString());
  });

  it("a failing notification.queued emit still lets booking.rescheduled + booking.created fire", async () => {
    // Regression: the sleeper-scheduling booking.* events must not be skipped
    // just because a notification trigger emit threw. A queued notification is
    // recoverable by the dispatcher's polling; the new row's reminders /
    // auto-complete sleepers have no such backstop, so keep the emits decoupled.
    const { deps } = buildDeps(state);
    const seen: string[] = [];
    deps.emit = async (event) => {
      seen.push(event.name);
      if (event.name === "notification.queued") throw new Error("inngest down");
    };

    const outcome = await applyReschedule(deps, {
      oldBookingId: OLD_BOOKING_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      oldScheduledStart: OLD_START,
      oldRescheduleCount: 0,
      newStartUtc: NEW_START,
      newEndUtc: NEW_END,
      bufferMin: 10,
    });

    expect(outcome.code).toBe("ok");
    // The notification emit threw, but both booking.* events fired from their
    // own try block.
    expect(seen).toContain("booking.rescheduled");
    expect(seen).toContain("booking.created");
    // The move still committed.
    expect(state.bookings.get(OLD_BOOKING_ID)?.status).toBe("rescheduled");
  });

  it("returns slot-conflict and mutates nothing when the unique constraint trips (P2002)", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    const { deps, emitted } = buildDeps(state, { throwOnCreate: p2002 });

    const outcome = await applyReschedule(deps, {
      oldBookingId: OLD_BOOKING_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      oldScheduledStart: OLD_START,
      oldRescheduleCount: 0,
      newStartUtc: NEW_START,
      newEndUtc: NEW_END,
      bufferMin: 10,
    });

    expect(outcome).toEqual({ code: "slot-conflict" });
    expect(state.bookings.get(OLD_BOOKING_ID)?.status).toBe("scheduled");
    // The whole tx rolls back — the budget is not charged on a failed move.
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(0);
    expect(state.notifications).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("returns package-not-found (not slot-conflict) when the package was deleted mid-reschedule", async () => {
    // Simulate the package vanishing between the caller's eligibility read and
    // this transaction: it isn't in the package map, so findUnique → null.
    state.packages.delete(PACKAGE_ID);
    const { deps, emitted } = buildDeps(state);

    const outcome = await applyReschedule(deps, {
      oldBookingId: OLD_BOOKING_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      oldScheduledStart: OLD_START,
      oldRescheduleCount: 0,
      newStartUtc: NEW_START,
      newEndUtc: NEW_END,
      bufferMin: 10,
    });

    expect(outcome).toEqual({ code: "package-not-found" });
    // The throw rolls the transaction back: the old-row flip is undone, no
    // notifications are enqueued, and nothing is emitted.
    expect(state.bookings.get(OLD_BOOKING_ID)?.status).toBe("scheduled");
    expect(state.notifications).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("moves a booking to a slot overlapping its own current interval (release-before-insert)", async () => {
    // Regression: the old order inserted the replacement BEFORE releasing the
    // old row, so a move whose new interval overlaps the old class's own
    // interval collided with the very row being replaced (the active-row
    // EXCLUDE/unique guards) and always failed. Model those guards: a create
    // conflicts with any *still-scheduled* booking that shares the exact start.
    const constrainedState = freshState();
    const { deps } = buildDeps(constrainedState);
    const realCreate = deps.prisma.booking.create;
    (deps.prisma.booking as { create: unknown }).create = vi.fn(
      async (args: { data: { scheduledStart: Date } }) => {
        for (const b of constrainedState.bookings.values()) {
          if (
            b.status === "scheduled" &&
            b.scheduledStart.getTime() === args.data.scheduledStart.getTime()
          ) {
            throw new Prisma.PrismaClientKnownRequestError("exclusion", {
              code: "P2002",
              clientVersion: "test",
            });
          }
        }
        return (realCreate as (a: unknown) => Promise<unknown>)(args);
      },
    );

    // Move onto the old class's exact start — an overlap with itself.
    const outcome = await applyReschedule(deps, {
      oldBookingId: OLD_BOOKING_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      oldScheduledStart: OLD_START,
      oldRescheduleCount: 0,
      newStartUtc: OLD_START,
      newEndUtc: new Date(OLD_START.getTime() + 50 * 60_000),
      bufferMin: 10,
    });

    // Because the old row is flipped to `rescheduled` first, it's no longer in
    // the active set, so the overlapping insert succeeds.
    expect(outcome.code).toBe("ok");
    expect(constrainedState.bookings.get(OLD_BOOKING_ID)?.status).toBe("rescheduled");
  });

  it("respects oldRescheduleCount when setting the new row's count (lineage depth)", async () => {
    // rescheduleCount records how deep a booking's reschedule chain is; the
    // handler must carry it forward (old + 1), not hard-code 1.
    const { deps } = buildDeps(state);

    const outcome = await applyReschedule(deps, {
      oldBookingId: OLD_BOOKING_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      packageId: PACKAGE_ID,
      oldScheduledStart: OLD_START,
      oldRescheduleCount: 3,
      newStartUtc: NEW_START,
      newEndUtc: NEW_END,
      bufferMin: 10,
    });
    if (outcome.code !== "ok") throw new Error();

    const created = state.bookings.get(outcome.newBookingId);
    expect(created?.rescheduleCount).toBe(4);
  });
});

// The teacher-initiated shape (teacher "change date and time"). The class
// still moves the same way; what differs is who pays for the move, who gets
// told, and that the intervention is audited.
describe("applyReschedule — teacher-initiated", () => {
  let state: FakeState;

  const teacherInput = {
    oldBookingId: OLD_BOOKING_ID,
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    packageId: PACKAGE_ID,
    oldScheduledStart: OLD_START,
    oldRescheduleCount: 0,
    newStartUtc: NEW_START,
    newEndUtc: NEW_END,
    bufferMin: 10,
    spendScheduleChange: false,
    notifyTeacher: false,
    override: { action: "teacher_reschedule_class", reason: "She moved the class." },
  };

  beforeEach(() => {
    state = freshState();
  });

  it("does not spend the student's pooled schedule-change budget", async () => {
    const { deps } = buildDeps(state);

    const outcome = await applyReschedule(deps, teacherInput);

    expect(outcome.code).toBe("ok");
    // The budget caps what the STUDENT can do unilaterally. A move she did not
    // ask for must not consume the one she has left — the same exemption
    // handleTeacherCancel takes when it refunds without charging it.
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(0);
    // The class still moved.
    expect(state.bookings.get(OLD_BOOKING_ID)?.status).toBe("rescheduled");
  });

  it("moves the class even when the package's budget is fully spent", async () => {
    // The case that made the exemption necessary rather than merely tidy: a
    // student who has used every schedule change still has a teacher who needs
    // to move Tuesday's class.
    state.packages.get(PACKAGE_ID)!.scheduleChangesUsed = 8; // classesTotal
    const { deps } = buildDeps(state);

    const outcome = await applyReschedule(deps, teacherInput);

    expect(outcome.code).toBe("ok");
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(8);
  });

  it("still tells the student, and does not mirror it back to the teacher", async () => {
    const { deps, emitted } = buildDeps(state);

    const outcome = await applyReschedule(deps, teacherInput);

    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();
    // A class must never move under the student silently.
    const student = state.notifications.filter((n) => n.templateName === "reschedule_confirm");
    expect(student).toHaveLength(1);
    expect(student[0].recipientType).toBe("student");
    expect(student[0].metadata).toEqual({ oldScheduledStart: OLD_START.toISOString() });
    // She made the move; telling her about it is noise.
    expect(
      state.notifications.filter((n) => n.templateName === "reschedule_confirm_teacher"),
    ).toHaveLength(0);
    expect(outcome.teacherNotificationId).toBeNull();
    // ...and no trigger is emitted for a notification that does not exist.
    expect(emitted.filter((e) => e.name === "notification.queued")).toHaveLength(1);
  });

  it("audits the move against the old booking, with both times", async () => {
    const { deps } = buildDeps(state);

    const outcome = await applyReschedule(deps, teacherInput);
    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();

    expect(state.overrides).toHaveLength(1);
    const row = state.overrides[0];
    expect(row.action).toBe("teacher_reschedule_class");
    expect(row.teacherId).toBe(TEACHER_ID);
    // Against the OLD row: that is the class she acted on, and the row the
    // student's class history already links its override log to.
    expect(row.targetType).toBe("booking");
    expect(row.targetId).toBe(OLD_BOOKING_ID);
    expect(row.beforeJson).toEqual({ scheduledStart: OLD_START.toISOString() });
    expect(row.afterJson).toEqual({
      scheduledStart: NEW_START.toISOString(),
      newBookingId: outcome.newBookingId,
    });
  });

  it("writes no audit row when the move loses the race", async () => {
    // The whole transaction rolls back, audit included — a log that records
    // moves that did not happen is worse than no log.
    state.bookings.get(OLD_BOOKING_ID)!.status = "canceled_by_student";
    const { deps } = buildDeps(state);

    const outcome = await applyReschedule(deps, teacherInput);

    expect(outcome.code).toBe("slot-conflict");
    expect(state.overrides).toHaveLength(0);
  });

  it("leaves the student flow's defaults alone — budget spent, teacher mirrored, nothing audited", async () => {
    const { deps } = buildDeps(state);

    const outcome = await applyReschedule(deps, {
      ...teacherInput,
      spendScheduleChange: undefined,
      notifyTeacher: undefined,
      override: undefined,
    });

    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();
    expect(state.packages.get(PACKAGE_ID)?.scheduleChangesUsed).toBe(1);
    expect(outcome.teacherNotificationId).not.toBeNull();
    expect(state.overrides).toHaveLength(0);
  });
});
