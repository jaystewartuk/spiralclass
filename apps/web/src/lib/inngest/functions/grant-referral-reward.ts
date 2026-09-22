import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { mintReservedRewardCode } from "@/lib/referrals";
import { notifyReferrerReward } from "@/lib/referrals/notify";
import { formatMinorUnits } from "@/lib/money";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { logger } from "@/lib/logger";
import { isAppLocale, DEFAULT_LOCALE } from "@spiralclass/shared";

const log = logger({ surface: "referrals" });

// Slice 2b: when a referred friend's payment settles, qualify the Referral and
// mint the referrer's reward (a reserved single-use discount code), then email
// the referrer. Fires on the same `payment.paid` event as the other settle-time
// jobs. Idempotent: a Referral that already has a reward code, or isn't in an
// attributed/qualified state, is skipped — so a retried or double-delivered
// event can't mint two rewards. Claim → mint → bind runs in ONE transaction:
// as separate writes, a crash between mint and bind left a live orphaned code
// while the rolled-forward claim state (qualified + null reward id) still
// passed the guard, so the retry minted a second live code.

type StepRunner = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

export async function grantReferralRewardHandler({
  event,
  step,
}: {
  event: { data: unknown };
  step: StepRunner;
}) {
  const { paymentId } = event.data as { paymentId: string };

  return await step.run("qualify-and-mint", async () => {
    const ref = await prisma.referral.findUnique({
      where: { paymentId },
      select: {
        id: true,
        teacherId: true,
        referralCodeId: true,
        status: true,
        referrerRewardCodeId: true,
      },
    });
    if (!ref) return { skipped: "no-referral" };
    if (ref.referrerRewardCodeId || ref.status === "rewarded" || ref.status === "void") {
      return { skipped: "already-handled" };
    }

    const program = await prisma.referralProgram.findUnique({
      where: { teacherId: ref.teacherId },
      select: {
        enabled: true,
        referrerKind: true,
        referrerPercentBps: true,
        referrerAmountMinorUnits: true,
        currency: true,
        rewardExpiryDays: true,
      },
    });
    if (!program || !program.enabled) return { skipped: "program-off" };

    // The referrer (code owner) gets the reward.
    const owner = await prisma.referralCode.findUnique({
      where: { id: ref.referralCodeId },
      select: {
        ownerStudentId: true,
        owner: { select: { email: true, name: true, locale: true, emailOptIn: true } },
        teacher: { select: { name: true } },
      },
    });
    if (!owner) return { skipped: "no-owner" };

    const expiresAt =
      program.rewardExpiryDays != null
        ? new Date(Date.now() + program.rewardExpiryDays * 24 * 60 * 60 * 1000)
        : null;

    // Claim → mint → bind atomically. The guarded claim keeps concurrent
    // deliveries out (loser matches 0 rows); the transaction keeps a crash
    // mid-mint from stranding a live, unbound reward code that a retry
    // would then duplicate.
    const reward = await prisma.$transaction(async (tx) => {
      const claim = await tx.referral.updateMany({
        where: {
          id: ref.id,
          status: { in: ["attributed", "qualified"] },
          referrerRewardCodeId: null,
        },
        data: { status: "qualified", qualifiedAt: new Date() },
      });
      if (claim.count === 0) return null;

      const minted = await mintReservedRewardCode(tx, {
        teacherId: ref.teacherId,
        ownerStudentId: owner.ownerStudentId,
        kind: program.referrerKind,
        percentBps: program.referrerPercentBps,
        amountMinorUnits: program.referrerAmountMinorUnits,
        currency: program.currency,
        expiresAt,
      });

      await tx.referral.update({
        where: { id: ref.id },
        data: { status: "rewarded", referrerRewardCodeId: minted.id },
      });
      return minted;
    });
    if (!reward) return { skipped: "race-lost" };

    const rewardLabel =
      program.referrerKind === "percent"
        ? `${(program.referrerPercentBps ?? 0) / 100}%`
        : formatMinorUnits(program.referrerAmountMinorUnits ?? 0);

    trackServerEvent({
      name: "referral_qualified",
      distinctId: owner.ownerStudentId,
      properties: { teacherId: ref.teacherId, referralId: ref.id },
    });
    trackServerEvent({
      name: "referral_rewarded",
      distinctId: owner.ownerStudentId,
      properties: {
        teacherId: ref.teacherId,
        referralId: ref.id,
        rewardMinorUnits: program.referrerAmountMinorUnits ?? undefined,
      },
    });
    // The only Inngest function that captures PostHog events without going
    // through a webhook route's own flush — drain explicitly so the step
    // doesn't complete (and the underlying function invocation exit) before
    // posthog-node's background flush fires.
    await flushAnalytics();

    // Email the referrer their code (best-effort; gated on email opt-in).
    if (owner.owner.email && owner.owner.emailOptIn) {
      try {
        await notifyReferrerReward({
          to: owner.owner.email,
          studentName: owner.owner.name,
          teacherName: owner.teacher.name,
          rewardCode: reward.code,
          rewardLabel,
          expiresAt,
          locale: isAppLocale(owner.owner.locale) ? owner.owner.locale : DEFAULT_LOCALE,
        });
      } catch (err) {
        log.warn("reward email threw", {
          referralId: ref.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { rewarded: true, rewardCodeId: reward.id };
  });
}

export const grantReferralRewardFn = inngest.createFunction(
  {
    id: "grant-referral-reward",
    retries: 2,
    triggers: [{ event: "payment.paid" }],
  },
  grantReferralRewardHandler,
);
