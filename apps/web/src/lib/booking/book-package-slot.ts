import type { PrismaClient } from "@prisma/client";
import { generateSlots } from "@/lib/slots";
import { isSlotConflictError } from "@/lib/booking/slot-conflict";
import { loadGoogleBusyBlocks } from "@/lib/calendar/google/busy";
import {
  enqueueBookingConfirmation,
  enqueueBookingCreatedTeacher,
} from "@/lib/notifications/enqueue";
import {
  checkCreditAvailability,
  claimNextCredit,
  type CreditPool,
} from "@/lib/booking/credit-ledger";
import { logger } from "@/lib/logger";

const log = logger({ surface: "book-package-slot" });

// Shared booking core — the authoritative path that turns a chosen package +
// slot into a `scheduled` booking. Extracted from the student createBooking
// action so the teacher self-serve flow (item 10) can reuse exactly the same
// slot generation re-validation, credit-ledger consumption and event fan-out rather than
// duplicating them.
//
// What lives here (caller-agnostic):
// * slot re-validation (availability windows, blocked dates, buffer,
// advance windows, collisions) — server is source of truth (server-authoritative).
//   * Atomic FIFO-by-expiry credit claim across the student's active packages
//     with this teacher (lib/booking/credit-ledger) — the soonest-to-expire
//     class is spent, so an older package can't lapse unused while a newer one
//     is drained. The per-package capacity guard keeps it race-safe; plus the
//     P2002 unique-index guard for the same-slot race.
//   * booking_confirmation enqueue (always — the student is always told).
//   * Post-commit fan-out: notification.queued + booking.created (the latter
//     schedules reminders and auto-complete — see Slice 4 sleepers).
//
// What the caller owns: auth/tenancy, resolving the package row, the analytics
// event (the student and teacher flows tag it differently), and the redirect.
//
// minAdvanceH bypass: a teacher booking something already agreed over WhatsApp
// should not be blocked by her own "book at least N hours ahead" rule, but she
// is NOT exempt from availability windows, blocked dates or slot collisions.
// We model the bypass by feeding minAdvanceH=0 to the generator; the `now`
// floor still prevents booking in the past.

export type BookingEventEmitter = (
  event:
    | {
        name: "notification.queued";
        data: { notificationId: string; teacherId: string };
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

export type BookPackageSlotDeps = {
  prisma: Pick<
    PrismaClient,
    | "availabilityRule"
    | "blockedDate"
    | "googleBusyInterval"
    | "booking"
    | "package"
    | "notification"
    | "override"
    | "$transaction"
  >;
  emit?: BookingEventEmitter;
};

// The package fields the booking core needs. The caller resolves this row
// (with whatever tenancy scoping its surface requires) before handing it over.
export type BookablePackage = {
  id: string;
  teacherId: string;
  studentId: string;
  classesUsed: number;
  classesTotal: number;
  classDurationMin: number;
  expiresAt: Date | null;
};

export type BookPackageSlotTeacher = {
  timezone: string;
  bufferMin: number;
  minAdvanceH: number;
  maxAdvanceDays: number;
};

export type BookPackageSlotInput = {
  // The package the caller resolved (with its own tenancy scoping). It names
  // the credit pool to spend from — teacher + class length — but does NOT fix
  // which credit is consumed: the core claims the soonest-to-expire eligible
  // credit in that pool (see studentIds).
  pkg: BookablePackage;
  // The student identity set the pool spans (multi-teacher inbox —
  // studentIdentityIds). Defaults to the package's own studentId, which is all
  // the teacher self-serve flow needs.
  studentIds?: string[];
  teacher: BookPackageSlotTeacher;
  startUtc: Date;
  now?: Date;
  // Skip the teacher's minAdvanceH window (teacher self-serve only).
  bypassMinAdvance?: boolean;
  // Enqueue the booking_created_teacher notification (student-initiated only;
  // a teacher booking it herself doesn't need telling).
  notifyTeacher?: boolean;
  // When set, write an Override audit row inside the same transaction so the
  // intervention is recorded like other teacher actions.
  override?: { action: string; reason: string } | null;
};

export type BookPackageSlotOutcome =
  | { code: "ok"; bookingId: string }
  | { code: "package-exhausted" }
  | { code: "package-expired" }
  | { code: "slot-unavailable" }
  | { code: "slot-taken" };

export async function bookPackageSlot(
  deps: BookPackageSlotDeps,
  input: BookPackageSlotInput,
): Promise<BookPackageSlotOutcome> {
  const { prisma } = deps;
  const { pkg, teacher } = input;
  const now = input.now ?? new Date();

  const pool: CreditPool = {
    teacherId: pkg.teacherId,
    studentIds: input.studentIds ?? [pkg.studentId],
    classDurationMin: pkg.classDurationMin,
  };

  const startUtc = input.startUtc;
  const endUtc = new Date(startUtc.getTime() + pkg.classDurationMin * 60_000);

  // Reason check across the whole pool (not just the referenced package): if
  // the student has any credit that still has capacity AND is valid at the CLASS
  // START, proceed. Using startUtc (not `now`) keeps this consistent with the
  // reschedule action: a credit that expires before the class can't be spent on
  // it. The claim inside the transaction is the authoritative race guard; this
  // just yields a precise, friendly error before doing the slot work.
  const availability = await checkCreditAvailability(prisma, pool, now, startUtc);
  if (availability.code === "exhausted") return { code: "package-exhausted" };
  if (availability.code === "expired") return { code: "package-expired" };

  // Re-run the generator for the chosen day and confirm the slot is
  // still on offer. Pull a 24h window around startUtc for the relevant rules.
  const dayBefore = new Date(startUtc.getTime() - 24 * 3600_000);
  const dayAfter = new Date(startUtc.getTime() + 24 * 3600_000);

  const [rules, blocked, googleBusy, bookings] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { teacherId: pkg.teacherId } }),
    prisma.blockedDate.findMany({
      where: {
        teacherId: pkg.teacherId,
        endsAt: { gt: dayBefore },
        startsAt: { lt: dayAfter },
      },
    }),
    // Google busy-import (Phase 3): external busy times block slots exactly
    // like blocked dates. Empty unless the teacher connected Google.
    loadGoogleBusyBlocks(pkg.teacherId, prisma),
    prisma.booking.findMany({
      where: {
        teacherId: pkg.teacherId,
        status: "scheduled",
        scheduledStart: { gte: dayBefore, lt: dayAfter },
      },
      // bufferMinSnapshot so the picker guards each booking by its own frozen
      // buffer, matching the DB overlap constraint (see generateSlots).
      select: { scheduledStart: true, scheduledEnd: true, bufferMinSnapshot: true },
    }),
  ]);

  const candidates = generateSlots({
    date: startUtc,
    classDurationMin: pkg.classDurationMin,
    teacher: {
      timezone: teacher.timezone,
      bufferMin: teacher.bufferMin,
      // The only rule a teacher self-serve booking bypasses. Everything else
      // (windows, blocked dates, buffer, collisions, max-advance) still binds.
      minAdvanceH: input.bypassMinAdvance ? 0 : teacher.minAdvanceH,
      maxAdvanceDays: teacher.maxAdvanceDays,
    },
    availabilityRules: rules,
    blockedDates: [...blocked, ...googleBusy],
    existingBookings: bookings,
    now,
  });

  const match = candidates.find((c) => c.startUtc.getTime() === startUtc.getTime());
  if (!match) return { code: "slot-unavailable" };

  let bookingId: string;
  let notificationId: string;
  let teacherNotificationId: string | null = null;
  let claimedPackageId: string = pkg.id;
  let claimedStudentId: string = pkg.studentId;
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Claim one class from the soonest-to-expire eligible credit in the pool.
      // The per-package field-comparison guard inside makes it race-safe; the
      // booking binds to whichever package the class actually came off, so
      // cancel/reschedule (which key off booking.packageId) return it correctly.
      const claimed = await claimNextCredit(
        tx,
        pool,
        now,
        prisma.package.fields.classesTotal,
        // Validity anchored on the class start — a credit expiring before the
        // class isn't eligible to fund it (see checkCreditAvailability above).
        startUtc,
      );
      if (!claimed) throw new Error("PACKAGE_FULL");

      // The slot generation availability read above (existingBookings) is a snapshot
      // taken before this transaction opened, so a booking committed in that
      // window is invisible to generateSlots — two students could otherwise
      // each pass the buffer check on stale reads and land classes closer
      // than the teacher's buffer. Race-proof enforcement lives at the DB
      // level: `bookings_no_overlap_buffered` (migration 20260703020000) is a
      // GiST EXCLUDE over [scheduled_start, buffered_end) per teacher, scoped
      // to scheduled rows — it can't be fooled by a concurrent transaction's
      // uncommitted row the way an app-level re-check can. Snapshot the
      // teacher's CURRENT buffer onto the row (see the column doc comment for
      // why — same pattern as locked purchase prices); `buffered_end` itself
      // is derived by a DB trigger from this value, not set here.
      const booking = await tx.booking.create({
        data: {
          packageId: claimed.packageId,
          teacherId: pkg.teacherId,
          studentId: claimed.studentId,
          scheduledStart: startUtc,
          scheduledEnd: endUtc,
          status: "scheduled",
          bufferMinSnapshot: teacher.bufferMin,
        },
      });
      const notifId = await enqueueBookingConfirmation(tx, {
        teacherId: pkg.teacherId,
        studentId: claimed.studentId,
        bookingId: booking.id,
      });
      let teacherNotifId: string | null = null;
      if (input.notifyTeacher) {
        teacherNotifId = await enqueueBookingCreatedTeacher(tx, {
          teacherId: pkg.teacherId,
          bookingId: booking.id,
        });
      }
      if (input.override) {
        await tx.override.create({
          data: {
            teacherId: pkg.teacherId,
            targetType: "booking",
            targetId: booking.id,
            action: input.override.action,
            reason: input.override.reason,
            afterJson: {
              scheduledStart: startUtc.toISOString(),
              scheduledEnd: endUtc.toISOString(),
              packageId: claimed.packageId,
              studentId: claimed.studentId,
            },
          },
        });
      }
      return {
        bookingId: booking.id,
        notifId,
        teacherNotifId,
        packageId: claimed.packageId,
        studentId: claimed.studentId,
      };
    });
    bookingId = result.bookingId;
    notificationId = result.notifId;
    teacherNotificationId = result.teacherNotifId;
    claimedPackageId = result.packageId;
    claimedStudentId = result.studentId;
  } catch (err) {
    if (err instanceof Error && err.message === "PACKAGE_FULL") {
      return { code: "package-exhausted" };
    }
    // Exact-start unique index (P2002), the plain interval-overlap EXCLUDE
    // constraint, or the buffered EXCLUDE constraint — all mean the slot
    // collides with (or sits inside the buffer of) another scheduled class.
    if (isSlotConflictError(err)) {
      return { code: "slot-taken" };
    }
    throw err;
  }

  // Post-commit fan-out: confirmation dispatch + reminder scheduling. Failures
  // here are logged and swallowed so the caller still completes; a stuck
  // `queued` row is recoverable.
  const emit = deps.emit;
  if (emit) {
    // The notification triggers and booking.created are emitted in SEPARATE try
    // blocks on purpose. A queued notification row is recoverable by the
    // dispatcher's own polling if its trigger emit fails, but booking.created is
    // what arms this booking's reminder wake chain (inngest/functions/
    // on-booking-created.ts re-runs the reminder scan at creation time, so the
    // tight 1h/15m legs fire on time for a class booked between two hourly
    // ticks — see lib/notifications/reminder-scan.ts). The hourly reminder-scan
    // cron is the backstop, so a lost emit costs at most an hour of precision,
    // never the reminder itself — but letting a notification emit failure abort
    // it would still needlessly pay that hour. Keep them independent.
    try {
      // The two notification.queued emits are independent — fan out concurrently.
      await Promise.all([
        emit({
          name: "notification.queued",
          data: { notificationId, teacherId: pkg.teacherId },
        }),
        ...(teacherNotificationId
          ? [
              emit({
                name: "notification.queued",
                data: { notificationId: teacherNotificationId, teacherId: pkg.teacherId },
              }),
            ]
          : []),
      ]);
    } catch (err) {
      log.error("notification emission failed", err);
    }
    try {
      await emit({
        name: "booking.created",
        data: {
          bookingId,
          teacherId: pkg.teacherId,
          studentId: claimedStudentId,
          packageId: claimedPackageId,
          scheduledStart: startUtc.toISOString(),
        },
      });
    } catch (err) {
      log.error("booking.created emission failed", err);
    }
  }

  return { code: "ok", bookingId };
}
