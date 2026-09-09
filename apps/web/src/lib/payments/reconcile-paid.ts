import type { PrismaClient } from "@prisma/client";
import { logger } from "@/lib/logger";

const log = logger({ surface: "reconcile-paid" });

// Backstop for the post-payment fan-out.
//
// When a Stripe payment settles, the webhook flips it to `paid` inside a
// transaction and THEN emits `payment.paid` OUTSIDE that transaction, as a
// best-effort try/catch (see webhook-handler.ts). That single event is the sole
// trigger for the teacher-payout transfer, the single-class auto-book, the
// referral reward, and the first-payment magic link. If the emit is lost — a
// transient Inngest send failure the handler swallows, or a crash/timeout in the
// post-commit window — the DB shows `paid` but none of those ran, the webhook
// already returned 200 so Stripe never retries, and the sibling
// `payment_intent.succeeded` event no-ops on the already-paid row. The teacher
// is then silently never paid for a real, charged sale, with no retry path and
// (before this) no reconcile.
//
// This sweep closes that hole. Because a lost emit takes ALL of the
// `payment.paid` consumers down together, re-emitting re-drives every one of
// them. Each consumer is idempotent — auto-book skips once the credit is spent,
// referral/magic-link dedupe — so re-emitting a payment whose fan-out actually
// completed is harmless.
//
// ONE stranded-signal now serves both rails: an unconsumed intended slot — a
// purchase that picked a class at checkout but whose own credit was never
// spent. Until D-143 the Stripe arm used `stripeTransferId IS NULL` instead
// ("the payout transfer never ran"), a signal that no longer exists: under
// direct charges the money settles on the teacher's own account and the
// platform never makes a transfer. With no payout step left on either rail,
// the two arms collapse into the same query.
//
// That shape is also produced legitimately when auto-book ran and found the
// slot already taken (it deliberately leaves the credit bookable rather than
// refunding), so a re-emit there is a no-op that re-runs and re-reports
// `slot-unavailable`; `maxAgeDays` bounds how long that repeats. Not covered:
// a lost emit for a package with no intended slot, where only the
// magic-link/referral consumers had work to do. That degrades to "the student
// doesn't get a sign-in email" — recoverable by signing in normally, and not
// worth a whole-table sweep to detect.
//
// One more shape the `classesUsed: 0` signal can't see through on its own: the
// booking core spends the soonest-to-expire credit across ALL of the student's
// active packages with the teacher (lib/booking/credit-ledger), so a top-up
// bought while an older package is still live has its first class booked on
// the OLDER package — the new one keeps `classesUsed: 0` for good even though
// the intent WAS honoured. Left alone, that re-emits payment.paid every tick
// for the whole `maxAgeDays` window and fans each one out to every consumer.
// The candidates are therefore post-filtered against the student's actual
// bookings with that teacher at the intended start (the same lookup auto-book
// itself uses for idempotency); a Prisma `where` can't compare a package's
// intended start to a sibling booking row's start, so it's a second query.

export type ReconcilePaidEmitter = (event: {
  name: "payment.paid";
  data: { paymentId: string; packageId: string; teacherId: string; studentId: string };
}) => Promise<void>;

export type ReconcilePaidDeps = {
  prisma: Pick<PrismaClient, "payment" | "booking">;
  emit: ReconcilePaidEmitter;
  now?: () => Date;
  // Grace before a paid-but-unbooked payment counts as stranded. The happy path
  // is near-instant, but the auto-book consumer has its own retry budget — don't
  // race it. Default 15 min.
  minAgeMinutes?: number;
  // Upper bound on how far back to scan, so a permanently-unbookable purchase
  // isn't re-emitted every run forever. Default 3 days, comfortably past
  // Stripe's own retry window.
  maxAgeDays?: number;
  // Cap deletions-style safety: bound work per run; the next run drains the rest.
  maxPerRun?: number;
};

export type ReconcilePaidOutcome = {
  scanned: number;
  reemitted: number;
  failed: number;
};

export async function reconcileStrandedPaidPayments(
  deps: ReconcilePaidDeps,
): Promise<ReconcilePaidOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const minAgeMs = (deps.minAgeMinutes ?? 15) * 60_000;
  const maxAgeMs = (deps.maxAgeDays ?? 3) * 24 * 3600_000;
  const upper = new Date(now.getTime() - minAgeMs);
  const lower = new Date(now.getTime() - maxAgeMs);

  const stranded = await deps.prisma.payment.findMany({
    where: {
      status: "paid",
      paidAt: { gte: lower, lte: upper },
      // Both rails: the class the student picked at checkout was never booked.
      // `status: "active"` because auto-book requires an active package — a
      // refunded/expired one would only ever re-emit into a no-op.
      package: {
        is: { intendedStartUtc: { not: null }, classesUsed: 0, status: "active" },
      },
    },
    select: {
      id: true,
      provider: true,
      package: {
        select: { id: true, teacherId: true, studentId: true, intendedStartUtc: true },
      },
    },
    orderBy: { paidAt: "asc" },
    take: deps.maxPerRun ?? 500,
  });

  // Drop the candidates whose intent already landed on another of the student's
  // packages (see the module header). One batched lookup keyed on
  // (teacher, student, start) — the tuple auto-book-intended dedupes on.
  const slotCandidates = stranded.filter((p) => p.package.intendedStartUtc !== null);
  const honoured = new Set<string>();
  if (slotCandidates.length > 0) {
    const landed = await deps.prisma.booking.findMany({
      where: {
        status: { notIn: ["canceled_by_student", "canceled_by_teacher"] },
        OR: slotCandidates.map((p) => ({
          teacherId: p.package.teacherId,
          studentId: p.package.studentId,
          scheduledStart: p.package.intendedStartUtc as Date,
        })),
      },
      select: { teacherId: true, studentId: true, scheduledStart: true },
    });
    for (const b of landed) {
      honoured.add(`${b.teacherId}:${b.studentId}:${b.scheduledStart.getTime()}`);
    }
  }
  const stillStranded = stranded.filter((p) => {
    if (p.package.intendedStartUtc === null) return true;
    const key = `${p.package.teacherId}:${p.package.studentId}:${p.package.intendedStartUtc.getTime()}`;
    return !honoured.has(key);
  });

  let reemitted = 0;
  let failed = 0;
  for (const p of stillStranded) {
    try {
      await deps.emit({
        name: "payment.paid",
        data: {
          paymentId: p.id,
          packageId: p.package.id,
          teacherId: p.package.teacherId,
          studentId: p.package.studentId,
        },
      });
      reemitted++;
    } catch (err) {
      failed++;
      log.error("re-emit payment.paid failed", err, { paymentId: p.id, provider: p.provider });
    }
  }

  if (stillStranded.length > 0) {
    log.warn("reconciled stranded paid payments", {
      scanned: stillStranded.length,
      reemitted,
      failed,
      // Split by rail. The two arms share one stranded-signal now, so a sudden
      // skew towards one points at that rail's emit path, not a general outage.
      stripe: stillStranded.filter((p) => p.provider === "stripe").length,
      wise: stillStranded.filter((p) => p.provider === "manual_transfer").length,
    });
  }

  return { scanned: stillStranded.length, reemitted, failed };
}
