import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { decideStudentCancel, scheduleChangeBudget } from "@/lib/cancellation/classify";
import {
  enqueueCancelGte24hTeacher,
  enqueueCancelGte24hWithReschedule,
  enqueueCancelLt24h,
  enqueueCancelLt24hTeacher,
  enqueueTeacherCancel,
} from "@/lib/notifications/enqueue";
import { logger } from "@/lib/logger";

const log = logger({ surface: "cancel-handler" });

// Thrown inside the student-cancel transaction when the pooled schedule-change
// budget is found exhausted at the moment we try to spend it (a concurrent
// cancel of a *different* booking in the same package took the last unit between
// our out-of-tx read and this write). Throwing rolls the whole transaction back
// — booking flip included — so the caller can report the cancel as refused.
class ScheduleBudgetExhausted extends Error {}

// Cancel handlers. Pure-ish data layer — no auth, no revalidate, no
// direct Inngest import — so server actions delegate here and tests pass
// an in-memory Prisma fake + a recording emitter. Mirrors the split used
// for payments (handleMpWebhook).

export type CancelEventEmitter = (
  event:
    | {
        name: "notification.queued";
        data: { notificationId: string; teacherId: string };
      }
    | {
        name: "booking.canceled";
        data: { bookingId: string; teacherId: string };
      },
) => Promise<void>;

export type CancelDeps = {
  prisma: Pick<PrismaClient, "booking" | "package" | "notification" | "override" | "$transaction">;
  emit?: CancelEventEmitter;
  now?: () => Date;
};

export type StudentCancelOutcome =
  | {
      code: "ok";
      timing: "lt24h" | "gte24h";
      notificationId: string;
      // Teacher-mirror notification id (always queued); null only if the
      // dispatcher decides to skip it later.
      teacherNotificationId: string;
      teacherId: string;
      bookingId: string;
    }
  | { code: "not-found" }
  | { code: "wrong-status" }
  // ≥24h cancel refused because the package's schedule-change budget is spent.
  // The refundable cancel is the last "free move" primitive; blocking it is
  // what stops cancel→rebook from out-running the reschedule budget.
  | { code: "schedule-changes-exhausted" };

export type TeacherCancelOutcome =
  | {
      code: "ok";
      notificationId: string;
      teacherId: string;
      studentId: string;
      bookingId: string;
    }
  | { code: "not-found" }
  | { code: "wrong-status" };

// Student-initiated cancel (Model B — class is committed at booking).
//   <24h  → status = canceled_by_student, stays committed (penalty), cancel_lt24h
//   ≥24h, budget left → status = canceled_by_student, classes_used -= 1 (refund),
//          schedule_changes_used += 1, cancel_gte24h_with_reschedule
//   ≥24h, budget spent → refused (schedule-changes-exhausted): a refundable
//          cancel is the cancel→rebook free-move primitive, so once the pooled
//          budget is gone we stop handing the class back. The student can still
//          forfeit (let it ride / no-show) or ask the teacher.
//
// tenant isolation: studentIds filter on the lookup; service-role does not bypass
// tenancy. The set is the caller's identity rows (studentIdentityIds) —
// the booking may live on a sibling row, so downstream notifications key
// off the booking's own studentId, not the caller's linked row.:
// server clock is the source of truth — caller can inject `now` but
// defaults to the real Date.
export async function handleStudentCancel(
  deps: CancelDeps,
  input: { bookingId: string; studentIds: string[] },
): Promise<StudentCancelOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  const booking = await deps.prisma.booking.findFirst({
    where: { id: input.bookingId, studentId: { in: input.studentIds } },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      packageId: true,
      status: true,
      scheduledStart: true,
      package: { select: { classesTotal: true, scheduleChangesUsed: true } },
    },
  });
  if (!booking) return { code: "not-found" };
  if (booking.status !== "scheduled") return { code: "wrong-status" };

  const decision = decideStudentCancel({
    now,
    scheduledStart: booking.scheduledStart,
    scheduleChangesUsed: booking.package.scheduleChangesUsed,
    scheduleChangesAllowed: scheduleChangeBudget(booking.package.classesTotal),
  });
  if (decision.blockedExhausted) return { code: "schedule-changes-exhausted" };

  let txResult;
  try {
    txResult = await deps.prisma.$transaction(async (tx) => {
      // Model B: the class was already committed at reservation.
      //   <24h  → keep it committed (the penalty). No quota change.
      //   ≥24h → release it: flag off + classes_used -= 1 (the refund) and spend
      //          one pooled schedule-change unit (the same budget reschedule uses).
      //
      // Race-safe flip: decideStudentCancel ran against a read taken *outside*
      // this transaction, so a double-submit (web + mobile, or a retried action)
      // could reach here twice. Guard the status transition with updateMany so the
      // second pass is a no-op — otherwise classes_used would be decremented and a
      // schedule-change unit spent twice (over-refund / budget over-spend).
      const flipped = await tx.booking.updateMany({
        where: { id: booking.id, status: "scheduled" },
        data: {
          status: "canceled_by_student",
          ...(decision.refundsClass ? { countsAgainstPackage: false } : {}),
        },
      });
      if (flipped.count === 0) return null;
      if (decision.chargesScheduleChange) {
        // Atomic pooled-budget claim. The status guard above stops a *same-booking*
        // double-submit, but two ≥24h cancels of *different* bookings in the same
        // package both read the budget out-of-tx (decideStudentCancel) and could
        // both pass the gate, overshooting scheduleChangesUsed past the cap. So
        // re-check the budget in the very statement that spends it: if a concurrent
        // cancel already took the last unit, the guarded updateMany matches no row
        // and we throw to roll the whole transaction back.
        const claimed = await tx.package.updateMany({
          where: {
            id: booking.packageId,
            scheduleChangesUsed: { lt: scheduleChangeBudget(booking.package.classesTotal) },
          },
          data: { scheduleChangesUsed: { increment: 1 } },
        });
        if (claimed.count === 0) throw new ScheduleBudgetExhausted();
      }
      if (decision.refundsClass) {
        // Floor-guarded refund — classes_used should never underflow (it's
        // COUNT of committed bookings, and this one is committed), but guard
        // it anyway rather than risk the raw packages_classes_used_bounds
        // CHECK constraint turning into an unhandled 500. Unlike the budget
        // claim above, a floor hit here means the invariant is already wrong
        // upstream, not a legitimate "no capacity" outcome — so it doesn't
        // block the cancel (the booking flip already succeeded), it just
        // skips the impossible decrement and logs loudly for follow-up.
        const refunded = await tx.package.updateMany({
          where: { id: booking.packageId, classesUsed: { gt: 0 } },
          data: { classesUsed: { decrement: 1 } },
        });
        if (refunded.count === 0) {
          log.error("classes_used already at floor — skipped refund on student cancel", undefined, {
            packageId: booking.packageId,
            bookingId: booking.id,
          });
        }
      }
      const notifId =
        decision.timing === "lt24h"
          ? await enqueueCancelLt24h(tx, {
              teacherId: booking.teacherId,
              studentId: booking.studentId,
              bookingId: booking.id,
            })
          : await enqueueCancelGte24hWithReschedule(tx, {
              teacherId: booking.teacherId,
              studentId: booking.studentId,
              bookingId: booking.id,
            });
      // Teacher mirror — the teacher needs to know the calendar opened up,
      // especially for last-minute (<24h) cancels.
      const teacherNotifId =
        decision.timing === "lt24h"
          ? await enqueueCancelLt24hTeacher(tx, {
              teacherId: booking.teacherId,
              bookingId: booking.id,
            })
          : await enqueueCancelGte24hTeacher(tx, {
              teacherId: booking.teacherId,
              bookingId: booking.id,
            });
      return { notificationId: notifId, teacherNotificationId: teacherNotifId };
    });
  } catch (err) {
    // A concurrent cancel spent the last pooled schedule-change unit between our
    // read and this write; the transaction rolled back, so report it exactly
    // like the read-time exhaustion check (no refund, no budget charge).
    if (err instanceof ScheduleBudgetExhausted) {
      return { code: "schedule-changes-exhausted" };
    }
    throw err;
  }

  // Lost the race (a concurrent cancel already moved the booking off
  // 'scheduled') — nothing was mutated this pass, so report it as such.
  if (!txResult) return { code: "wrong-status" };
  const { notificationId, teacherNotificationId } = txResult;

  await emitCancelEvents(deps.emit, {
    notificationIds: [notificationId, teacherNotificationId],
    teacherId: booking.teacherId,
    bookingId: booking.id,
  });

  return {
    code: "ok",
    timing: decision.timing,
    notificationId,
    teacherNotificationId,
    teacherId: booking.teacherId,
    bookingId: booking.id,
  };
}

// Statuses a teacher cancel can act on. A teacher cancellation always refunds
// the class and never penalizes the student, so it doubles as the "forgive a
// past class" path: a `completed` (auto-completed) or `no_show` class the
// teacher decides to give back — e.g. the student had a valid reason for
// missing it — is returned to the package exactly like a pre-class cancel. All
// three are committed against the package (Model B), so the refund is one class.
const TEACHER_CANCELABLE = ["scheduled", "completed", "no_show"] as const;

// Teacher-initiated cancel. Refunds the committed class (Model B:
// classes_used -= 1, flag off) + logs an Override row keyed on the booking
// so teacher overrides student-facing history shows the reason. Also serves as the
// forgive-a-past-class path (see TEACHER_CANCELABLE).
export async function handleTeacherCancel(
  deps: CancelDeps,
  input: { bookingId: string; teacherId: string; reason: string },
): Promise<TeacherCancelOutcome> {
  const booking = await deps.prisma.booking.findFirst({
    where: { id: input.bookingId, teacherId: input.teacherId },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      packageId: true,
      status: true,
      scheduledStart: true,
      scheduledEnd: true,
    },
  });
  if (!booking) return { code: "not-found" };
  if (!(TEACHER_CANCELABLE as readonly string[]).includes(booking.status)) {
    return { code: "wrong-status" };
  }

  const txResult = await deps.prisma.$transaction(async (tx) => {
    const before = {
      status: booking.status,
      scheduledStart: booking.scheduledStart.toISOString(),
      scheduledEnd: booking.scheduledEnd.toISOString(),
    };
    // Race-safe flip guarded on the current status — a double-submit (web +
    // mobile, or a retried action) must not decrement classes_used twice.
    // `completed_at` is cleared so a forgiven past class doesn't keep its
    // auto-complete stamp.
    const flipped = await tx.booking.updateMany({
      where: { id: booking.id, status: booking.status },
      data: { status: "canceled_by_teacher", countsAgainstPackage: false, completedAt: null },
    });
    if (flipped.count === 0) return null;
    // Model B: teacher cancel never penalizes the student — release the
    // committed slot back to the package. Floor-guarded (see the matching
    // comment in handleStudentCancel above) — a floor hit means the
    // invariant is already wrong upstream, not a reason to block the cancel.
    const refunded = await tx.package.updateMany({
      where: { id: booking.packageId, classesUsed: { gt: 0 } },
      data: { classesUsed: { decrement: 1 } },
    });
    if (refunded.count === 0) {
      log.error("classes_used already at floor — skipped refund on teacher cancel", undefined, {
        packageId: booking.packageId,
        bookingId: booking.id,
      });
    }
    await tx.override.create({
      data: {
        teacherId: input.teacherId,
        targetType: "booking",
        targetId: booking.id,
        action: "teacher_cancel",
        reason: input.reason,
        beforeJson: before,
        afterJson: { ...before, status: "canceled_by_teacher" },
      },
    });
    const notifId = await enqueueTeacherCancel(tx, {
      teacherId: input.teacherId,
      studentId: booking.studentId,
      bookingId: booking.id,
    });
    return { notificationId: notifId };
  });

  // Lost the race (a concurrent action already moved the booking) — nothing
  // mutated this pass, so report it as a stale status.
  if (!txResult) return { code: "wrong-status" };

  // Teacher initiated the cancel themselves, so no teacher-mirror is needed.
  await emitCancelEvents(deps.emit, {
    notificationIds: [txResult.notificationId],
    teacherId: input.teacherId,
    bookingId: booking.id,
  });

  return {
    code: "ok",
    notificationId: txResult.notificationId,
    teacherId: input.teacherId,
    studentId: booking.studentId,
    bookingId: booking.id,
  };
}

async function emitCancelEvents(
  emit: CancelEventEmitter | undefined,
  input: { notificationIds: string[]; teacherId: string; bookingId: string },
): Promise<void> {
  if (!emit) return;
  // The notification triggers and the booking.canceled event are emitted in
  // SEPARATE try blocks on purpose. A queued notification row is recoverable
  // by the dispatcher's own polling if its trigger emit fails, but
  // booking.canceled short-circuits the reminder/auto-complete sleepers for the
  // now-canceled row — if a notification emit failure aborted it too, those
  // sleepers would keep firing against a canceled booking. Keep them independent.
  try {
    // The per-notification emits are independent of each other, so fan them out
    // concurrently instead of awaiting one at a time.
    await Promise.all(
      input.notificationIds.map((notificationId) =>
        emit({
          name: "notification.queued",
          data: { notificationId, teacherId: input.teacherId },
        }),
      ),
    );
  } catch (err) {
    log.error("notification emission failed", err);
  }
  try {
    await emit({
      name: "booking.canceled",
      data: { bookingId: input.bookingId, teacherId: input.teacherId },
    });
  } catch (err) {
    log.error("booking.canceled emission failed", err);
  }
}

// Convenience default for production callers — production uses the singleton
// Prisma client. Tests always pass their own deps.
export const defaultCancelDeps = {
  prisma: defaultPrisma as unknown as CancelDeps["prisma"],
};
