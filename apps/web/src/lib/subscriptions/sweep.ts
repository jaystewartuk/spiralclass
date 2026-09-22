import type { PrismaClient } from "@prisma/client";
import { enqueueSubscriptionTrialEnding } from "@/lib/notifications/enqueue";
import { PAST_DUE_GRACE_DAYS, TRIAL_ENDING_NOTICE_DAYS } from "./config";
import { dropToFree, type LifecycleEmitter } from "./lifecycle";
import { logger } from "@/lib/logger";

const log = logger({ surface: "subscription-sweep" });

// Daily sweep that drives the time-based subscription transitions the webhook
// can't (Stripe doesn't emit "the trial elapsed" for our no-card app trial):
//   1. trialing + trialEndsAt passed  → drop to Free
//   2. past_due  + grace elapsed      → drop to Free
//   3. trialing + ~3 days left        → one-time "trial ending" nudge
// Idempotent: the trial-ending nudge is deduped per subscription via a
// `trialEndingNoticeSentAt`-style marker carried in the notification log (we
// check for an existing row rather than adding a column).

export type SubscriptionSweepDeps = {
  prisma: PrismaClient;
  emit?: LifecycleEmitter;
  now?: () => Date;
};

export type SubscriptionSweepResult = {
  droppedFromTrial: number;
  droppedFromPastDue: number;
  trialEndingNudges: number;
};

export async function runSubscriptionSweep(
  deps: SubscriptionSweepDeps,
): Promise<SubscriptionSweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const lifecycleDeps = { prisma: deps.prisma, emit: deps.emit, now: () => now };

  // 1. Expired trials → Free.
  const expiredTrials = await deps.prisma.teacherSubscription.findMany({
    where: { status: "trialing", comped: false, trialEndsAt: { lte: now } },
    select: { teacherId: true },
  });
  for (const t of expiredTrials) {
    await dropToFree(lifecycleDeps, { teacherId: t.teacherId, reason: "trial_expired" });
  }

  // 2. past_due whose grace has elapsed → Free.
  const graceCutoff = new Date(now.getTime() - PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const lapsedPastDue = await deps.prisma.teacherSubscription.findMany({
    where: {
      status: "past_due",
      comped: false,
      currentPeriodEnd: { lte: graceCutoff },
    },
    select: { teacherId: true },
  });
  for (const t of lapsedPastDue) {
    await dropToFree(lifecycleDeps, {
      teacherId: t.teacherId,
      reason: "past_due_grace_elapsed",
    });
  }

  // 3. Trials ending within TRIAL_ENDING_NOTICE_DAYS → one-time nudge.
  const noticeWindowEnd = new Date(now.getTime() + TRIAL_ENDING_NOTICE_DAYS * 24 * 60 * 60 * 1000);
  const endingSoon = await deps.prisma.teacherSubscription.findMany({
    where: {
      status: "trialing",
      comped: false,
      trialEndsAt: { gt: now, lte: noticeWindowEnd },
    },
    select: { teacherId: true, trialEndsAt: true },
  });
  // Dedup in one shot: load every teacher who already has a trial-ending
  // notice, rather than firing a findFirst per teacher inside the loop (an
  // N+1 that scaled with the size of the ending-soon cohort).
  const alreadyNudged = new Set<string>(
    endingSoon.length === 0
      ? []
      : (
          await deps.prisma.notification.findMany({
            where: {
              templateName: "subscription_trial_ending",
              teacherId: { in: endingSoon.map((t) => t.teacherId) },
            },
            select: { teacherId: true },
          })
        )
          .map((n) => n.teacherId)
          .filter((id): id is string => id !== null),
  );

  let trialEndingNudges = 0;
  for (const t of endingSoon) {
    // Dedup: skip if we already sent this teacher a trial-ending notice.
    if (alreadyNudged.has(t.teacherId)) continue;
    const daysRemaining = Math.max(
      1,
      Math.ceil((t.trialEndsAt!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    );
    const notifId = await enqueueSubscriptionTrialEnding(deps.prisma, {
      teacherId: t.teacherId,
      daysRemaining,
    });
    if (deps.emit) {
      try {
        await deps.emit({
          name: "notification.queued",
          data: { notificationId: notifId, teacherId: t.teacherId },
        });
      } catch (err) {
        log.warn("emit trial-ending failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    trialEndingNudges += 1;
  }

  return {
    droppedFromTrial: expiredTrials.length,
    droppedFromPastDue: lapsedPastDue.length,
    trialEndingNudges,
  };
}
