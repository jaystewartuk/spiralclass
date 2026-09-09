import type { PrismaClient } from "@prisma/client";
import { isSlotConflictError } from "@/lib/booking/slot-conflict";
import {
  enqueueRescheduleConfirm,
  enqueueRescheduleConfirmTeacher,
} from "@/lib/notifications/enqueue";
import { scheduleChangeBudget } from "./classify";
import { logger } from "@/lib/logger";

const log = logger({ surface: "reschedule-handler" });

// Thrown inside the reschedule transaction when a guarded mutation finds the
// row already moved / the budget already spent by a concurrent operation. The
// caller maps it to `slot-conflict` and the transaction rolls back the newly
// created replacement booking.
class RescheduleRaceError extends Error {}
// Distinct from a lost race: the package backing this booking no longer exists
// (deleted between the caller's eligibility read and this transaction). Surfaced
// as its own outcome so it isn't mis-reported as "slot-conflict".
class RescheduleMissingPackageError extends Error {}

// Reschedule data layer. Caller has already validated:
//   * booking is `scheduled`, package has schedule-change budget left, ≥24h ahead
// * new slot is in the same Mon–Sun calendar week (teacher tz, server-authoritative)
// * new slot survives the generator
//
// This handler owns:
//   * Insert new booking (rescheduleOfBookingId = old.id, count = old.count+1)
//   * Mark old booking `rescheduled` (its reminder/auto-complete sleepers
//     short-circuit on the status change — see auto-complete.ts)
//   * Spend one schedule-change unit on the package (the shared budget a ≥24h
//     cancel also draws from — see classify.ts)
//   * Enqueue reschedule_confirm notification carrying oldScheduledStart
//   * Post-commit emit booking.rescheduled + a fresh booking.created so
//     Slice 4 sleepers fan out for the new row against the new start.
//
// Reschedule does NOT shift package quota — the same class still exists on
// a different day. classes_used is untouched: the new row enters the
// committed count (counts_against_package = true) and the old row leaves it
// (set false below), so the aggregate nets to zero. schedule_changes_used,
// though, does move: a move is a move whether done by reschedule or by
// cancel+rebook, and both spend from the same pool.

export type RescheduleEventEmitter = (
  event:
    | {
        name: "notification.queued";
        data: { notificationId: string; teacherId: string };
      }
    | {
        name: "booking.rescheduled";
        data: {
          bookingId: string;
          teacherId: string;
          newScheduledStart: string;
        };
      }
    | {
        name: "booking.created";
        data: {
          bookingId: string;
          teacherId: string;
          studentId: string;
          packageId: string;
          scheduledStart: string;
        };
      },
) => Promise<void>;

export type RescheduleDeps = {
  prisma: Pick<PrismaClient, "booking" | "package" | "notification" | "$transaction">;
  emit?: RescheduleEventEmitter;
};

export type RescheduleOutcome =
  | {
      code: "ok";
      newBookingId: string;
      notificationId: string;
      teacherNotificationId: string;
    }
  | { code: "slot-conflict" }
  | { code: "package-not-found" };

export async function applyReschedule(
  deps: RescheduleDeps,
  input: {
    oldBookingId: string;
    teacherId: string;
    studentId: string;
    packageId: string;
    oldScheduledStart: Date;
    oldRescheduleCount: number;
    newStartUtc: Date;
    newEndUtc: Date;
    // Teacher's CURRENT buffer_min, snapshotted onto the replacement row so
    // the DB-level `bookings_no_overlap_buffered` EXCLUDE constraint can
    // enforce it race-proof (see the schema column doc comment). The caller
    // already loads this for its own slot re-validation.
    bufferMin: number;
  },
): Promise<RescheduleOutcome> {
  let newBookingId: string;
  let notificationId: string;
  let teacherNotificationId: string;
  try {
    const result = await deps.prisma.$transaction(async (tx) => {
      // Release the OLD booking BEFORE inserting the replacement. Both DB slot
      // guards — the GiST EXCLUDE `bookings_no_overlap_active` and the partial
      // unique `bookings_teacher_slot_active_unique` — are scoped to
      // status='scheduled' rows and evaluated at insert time. If the new slot
      // overlaps (or shares a start with) the old class's own interval — a
      // student nudging their class 30 min, say — creating the new row first
      // collides with the very row being replaced and always fails. Flipping
      // the old row to 'rescheduled' first takes it out of the active set, so
      // an overlapping move succeeds while a genuine clash with a *different*
      // booking still trips the constraint and rolls the release back.
      //
      // Race-safe release: eligibility was checked on a read taken outside this
      // transaction, so a double-submit could reach here twice. Guard the
      // transition with updateMany so the second pass can't release the row —
      // and therefore can't spend a second schedule-change unit.
      const released = await tx.booking.updateMany({
        where: { id: input.oldBookingId, status: "scheduled" },
        data: { status: "rescheduled", countsAgainstPackage: false },
      });
      if (released.count === 0) throw new RescheduleRaceError();
      // Spend one unit of the package's pooled schedule-change budget. Eligibility
      // (budget left) was checked by the caller; commit it with a guard against
      // the computed allowance so two concurrent reschedules on the *same*
      // package can't push scheduleChangesUsed past the budget.
      const pkg = await tx.package.findUnique({
        where: { id: input.packageId },
        select: { classesTotal: true },
      });
      // A null package means it was deleted out from under this reschedule.
      // Fail explicitly instead of falling through to a budget guard computed
      // from `classesTotal ?? 0` (budget 0), which would always trip the
      // updateMany guard and be mis-reported as a slot-conflict.
      if (!pkg) throw new RescheduleMissingPackageError();
      const spent = await tx.package.updateMany({
        where: {
          id: input.packageId,
          scheduleChangesUsed: { lt: scheduleChangeBudget(pkg.classesTotal) },
        },
        data: { scheduleChangesUsed: { increment: 1 } },
      });
      if (spent.count === 0) throw new RescheduleRaceError();
      // Now that the old row is out of the active set, insert the replacement.
      const created = await tx.booking.create({
        data: {
          packageId: input.packageId,
          teacherId: input.teacherId,
          studentId: input.studentId,
          scheduledStart: input.newStartUtc,
          scheduledEnd: input.newEndUtc,
          status: "scheduled",
          rescheduleOfBookingId: input.oldBookingId,
          rescheduleCount: input.oldRescheduleCount + 1,
          // `buffered_end` is derived by a DB trigger from this value — see
          // the column doc comment on Booking.bufferedEnd.
          bufferMinSnapshot: input.bufferMin,
        },
      });
      const notifId = await enqueueRescheduleConfirm(tx, {
        teacherId: input.teacherId,
        studentId: input.studentId,
        bookingId: created.id,
        oldScheduledStart: input.oldScheduledStart,
      });
      const teacherNotifId = await enqueueRescheduleConfirmTeacher(tx, {
        teacherId: input.teacherId,
        bookingId: created.id,
        oldScheduledStart: input.oldScheduledStart,
      });
      return { newBookingId: created.id, notifId, teacherNotifId };
    });
    newBookingId = result.newBookingId;
    notificationId = result.notifId;
    teacherNotificationId = result.teacherNotifId;
  } catch (err) {
    // A concurrent cancel/reschedule already moved the old row off 'scheduled'
    // (or exhausted the budget under the guard) — treat it as a lost race.
    if (err instanceof RescheduleMissingPackageError) {
      return { code: "package-not-found" };
    }
    if (err instanceof RescheduleRaceError) {
      return { code: "slot-conflict" };
    }
    // Exact-start unique index (P2002) or interval-overlap EXCLUDE constraint.
    if (isSlotConflictError(err)) {
      return { code: "slot-conflict" };
    }
    throw err;
  }

  const emit = deps.emit;
  if (emit) {
    // The notification triggers and the booking.* events are emitted in SEPARATE
    // try blocks on purpose. Queued notification rows are recoverable by the
    // dispatcher's own polling if their trigger emits fail, but booking.rescheduled
    // short-circuits the OLD row's sleepers and booking.created schedules the NEW
    // row's reminders + auto-complete — letting a notification emit failure abort
    // them would leave the old row's sleepers firing and silently drop the new
    // row's reminders. Keep them independent.
    try {
      await emit({
        name: "notification.queued",
        data: { notificationId, teacherId: input.teacherId },
      });
      await emit({
        name: "notification.queued",
        data: { notificationId: teacherNotificationId, teacherId: input.teacherId },
      });
    } catch (err) {
      log.error("notification emission failed", err);
    }
    try {
      await emit({
        name: "booking.rescheduled",
        data: {
          bookingId: input.oldBookingId,
          teacherId: input.teacherId,
          newScheduledStart: input.newStartUtc.toISOString(),
        },
      });
      await emit({
        name: "booking.created",
        data: {
          bookingId: newBookingId,
          teacherId: input.teacherId,
          studentId: input.studentId,
          packageId: input.packageId,
          scheduledStart: input.newStartUtc.toISOString(),
        },
      });
    } catch (err) {
      log.error("booking event emission failed", err);
    }
  }

  return { code: "ok", newBookingId, notificationId, teacherNotificationId };
}
