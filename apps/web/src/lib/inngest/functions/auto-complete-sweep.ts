import * as Sentry from "@sentry/nextjs";
import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { maybeCompleteBooking } from "@/lib/cancellation/auto-complete";

// Hourly: complete any `scheduled` booking whose `scheduled_end` has
// passed. As of Phase 2b-ii (docs/architecture/overview.md)
// this is the SOLE auto-complete path — the per-booking `sleepUntil` fan-out
// (former auto-complete-booking.ts) is deleted, because a due-scan needs no
// durable timer to orphan at the Inngest→pg-boss cutover. Idempotent:
// `maybeCompleteBooking` no-ops when the booking is already non-scheduled.

const BATCH_LIMIT = 200;

type StepRunner = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

// Exported for unit testing — drives the batch with a fake step runner.
export async function autoCompleteSweepHandler({ step }: { step: StepRunner }) {
  const stale = await step.run("find-stale-bookings", async () => {
    const cutoff = new Date();
    return prisma.booking.findMany({
      where: {
        status: "scheduled",
        scheduledEnd: { lt: cutoff },
      },
      select: { id: true, teacherId: true, packageId: true },
      take: BATCH_LIMIT,
      orderBy: { scheduledEnd: "asc" },
    });
  });

  let completed = 0;
  let skipped = 0;
  let failed = 0;
  for (const b of stale) {
    // Per-item isolation: a single permanently-failing booking must not wedge
    // the whole hourly batch (mirrors wise-reconcile's per-teacher try/catch).
    // The step is idempotent, so a transient failure is retried by the step
    // itself; a terminal failure is logged and the sweep moves on.
    try {
      const result = await step.run(`complete-${b.id}`, () =>
        maybeCompleteBooking({
          bookingId: b.id,
          teacherId: b.teacherId,
          packageId: b.packageId,
        }),
      );
      if (result.completed) completed += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      Sentry.captureException(err, {
        tags: { surface: "auto-complete-sweep" },
        extra: { bookingId: b.id, teacherId: b.teacherId, packageId: b.packageId },
      });
    }
  }
  return { found: stale.length, completed, skipped, failed };
}

export const autoCompleteSweepCronFn = inngest.createFunction(
  {
    id: "auto-complete-sweep-cron",
    retries: 1,
    // Back to hourly (D-115). Phase 2b-ii had tightened this to */15 so that
    // completion — and with it the earned-vs-held split on the cash-flow
    // dashboard — landed within ~15 min of scheduledEnd rather than ~60. That
    // quarter-hourly grid cost ~89 of the 100 free Neon CU-hours a month for
    // the whole fleet, and this sweep moves no money: it flips a booking status
    // and reclassifies revenue already collected. The 45 minutes of extra lag
    // on a dashboard number is the cheapest thing the fleet had to give up.
    triggers: [{ cron: "0 * * * *" }],
  },
  autoCompleteSweepHandler,
);
