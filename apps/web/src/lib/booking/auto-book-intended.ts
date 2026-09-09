import { bookPackageSlot, type BookPackageSlotDeps } from "@/lib/booking/book-package-slot";
import { logger } from "@/lib/logger";

const log = logger({ surface: "auto-book-intended" });

// Pay-at-reservation completion step.
//
// The student picks the slot *before* paying; the chosen UTC start is stored
// on the Package (`intendedStartUtc`). Since D-111 that applies to ANY
// offering: for a single class the slot IS the reservation and checkout
// requires it, for a multi-class package it is an optional "pick your first
// class" and the remaining credits are booked from the portal later. Once the
// payment lands — Stripe webhook or Wise confirm, both emit `payment.paid` —
// this turns that intent into a real booking, reusing the same booking core
// (slot generation re-validation + credit consumption) as every other booking so the
// confirmation emails, reminders and teacher heads-up all fire identically.
//
// Graceful degradation is the whole point: between the student paying and a
// slow rail (Wise) confirming, the slot can be taken by someone else, or the
// class time can slip into the past. In that case we DON'T refund or error —
// the credit is a perfectly good one, so we leave it bookable and the student
// simply picks a new time from their balance (they already got the
// `payment_received` notification pointing them there). No money is lost.

// The booking core's deps already expose the `package`, `booking` and
// `$transaction` models this step reads, so no extra surface is needed.
export type AutoBookIntendedDeps = BookPackageSlotDeps;

export type AutoBookIntendedOutcome =
  | { code: "booked"; bookingId: string }
  | { code: "no-intent" }
  | { code: "not-active" }
  | { code: "already-booked" }
  // The slot was unavailable/taken/in the past by the time payment cleared.
  // The credit stays bookable — this is an expected, non-error outcome.
  | { code: "slot-unavailable" };

export async function autoBookIntendedSlot(
  deps: AutoBookIntendedDeps,
  packageId: string,
  now: Date = new Date(),
): Promise<AutoBookIntendedOutcome> {
  const pkg = await deps.prisma.package.findUnique({
    where: { id: packageId },
    include: {
      teacher: {
        select: {
          timezone: true,
          bufferMin: true,
          minAdvanceH: true,
          maxAdvanceDays: true,
        },
      },
    },
  });

  // No package, or an ordinary multi-class purchase with no chosen slot —
  // nothing to auto-book.
  if (!pkg || pkg.intendedStartUtc === null) return { code: "no-intent" };
  // Defensive: payment.paid should have activated it first.
  if (pkg.status !== "active") return { code: "not-active" };
  // Idempotency: a duplicate payment.paid (Stripe re-delivers webhooks, and the
  // reconcile-paid sweep re-emits deliberately) must not book the intended slot
  // twice.
  //
  // The cheap balance check is exact ONLY for a 1-class package whose own credit
  // was the one spent. A multi-class package still has headroom after the first
  // booking, so it needs the real question asked: is this student already booked
  // with this teacher into the slot the purchase intended?
  //
  // Matched on the STUDENT + teacher + start — deliberately NOT on packageId.
  // The booking core spends the soonest-to-expire eligible credit across ALL of
  // the student's active packages with this teacher (lib/booking/credit-ledger),
  // so a top-up bought by a student who still holds an older package lands its
  // first class on THAT older package's credit — the booking row's packageId is
  // the older package, not the one just paid for. A packageId-scoped lookup
  // then misses it and this step re-runs the booking core on every redelivery
  // (rescued only by the slot collision, and reported as `slot-unavailable`
  // each time). Other classes booked from the balance in between don't match:
  // they sit at other start times.
  //
  // Only genuinely-cancelled rows are excluded: a RESCHEDULED booking keeps its
  // original `scheduledStart` and is merely flagged `rescheduled`
  // (applyReschedule marks the old row and inserts a new one), so it still
  // matches here and still blocks — which is what we want, since the intent was
  // already honoured once.
  if (pkg.classesUsed >= pkg.classesTotal) return { code: "already-booked" };
  const already = await deps.prisma.booking.findFirst({
    where: {
      teacherId: pkg.teacherId,
      studentId: pkg.studentId,
      scheduledStart: pkg.intendedStartUtc,
      status: { notIn: ["canceled_by_student", "canceled_by_teacher"] },
    },
    select: { id: true },
  });
  if (already) return { code: "already-booked" };

  const outcome = await bookPackageSlot(deps, {
    pkg: {
      id: pkg.id,
      teacherId: pkg.teacherId,
      studentId: pkg.studentId,
      classesUsed: pkg.classesUsed,
      classesTotal: pkg.classesTotal,
      classDurationMin: pkg.classDurationMin,
      expiresAt: pkg.expiresAt,
    },
    teacher: pkg.teacher,
    startUtc: pkg.intendedStartUtc,
    now,
    // The student chose this time at checkout, so the teacher should be told a
    // class just landed — same as any student-initiated booking.
    notifyTeacher: true,
  });

  if (outcome.code === "ok") {
    log.info("auto-booked intended slot", {
      packageId,
      bookingId: outcome.bookingId,
    });
    return { code: "booked", bookingId: outcome.bookingId };
  }

  // Expected, recoverable: the slot was gone by the time payment cleared. Leave
  // the credit bookable — see the module header. Logged at warn so it's
  // visible without paging.
  log.warn("intended slot no longer bookable; credit left for re-booking", {
    packageId,
    intendedStartUtc: pkg.intendedStartUtc.toISOString(),
    reason: outcome.code,
  });
  return { code: "slot-unavailable" };
}
