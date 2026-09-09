import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  enqueueRefundIssuedStudent,
  enqueueRefundIssuedTeacher,
} from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { voidReferralRewardForPayment } from "@/lib/referrals";

type Tx = Prisma.TransactionClient;

/**
 * Everything that happens after Stripe accepts a refund, in one place.
 *
 * There are four refund entry points — teacher web, teacher mobile, admin web,
 * admin mobile — plus the `charge.refunded` webhook, and they had drifted into
 * five different answers to "what does a refund do":
 *
 *   * NONE of the four told the student. Only the webhook enqueued
 *     `refund_issued_student`, and it could never run for an app-initiated
 *     refund: the action flipped `Payment.status` to `refunded` itself, so by
 *     the time Stripe's `charge.refunded` arrived `advancePayment` returned
 *     `already-refunded` and skipped the notifications with it. A student's
 *     package silently became "Reembolsado" with no email, no push and no
 *     inbox row — for a template deliberately classed as money-of-record and
 *     therefore non-silenceable (see notifications/preferences.ts).
 *   * The teacher was told only by the webhook, i.e. also never.
 *   * Both admin paths skipped `voidReferralRewardForPayment`, leaving a
 *     referrer holding a live reward for a purchase that had been given back.
 *   * Both admin paths flipped without the `status: "paid"` guard the teacher
 *     paths use, so two concurrent refunds could both write audit rows.
 *
 * Callers keep what is genuinely theirs — authorization, the Stripe call, and
 * their own audit row (teacher `refund` vs admin `admin_refund`, with the
 * actor) — and hand the rest here.
 *
 * The `charge.refunded` webhook is the fifth path and deliberately does NOT
 * come through here: it shares one generic state machine with the paid and
 * failed transitions (`advancePayment` + `applyTransition`), including its
 * injected prisma/emit seams, and unpicking that for one branch would risk the
 * whole payment webhook to remove a duplication of a few lines. Its
 * `flip-refunded` branch must keep doing what this does — same two templates,
 * same clawback — and `webhook-handler.test.ts` plus the tests here hold both
 * ends of that.
 *
 * Returns `applied: false` when the guarded flip matched no rows, meaning
 * another refund got there first. Nothing was written and nothing was sent.
 */
export async function applyRefund(args: {
  payment: { id: string };
  package: { id: string; teacherId: string; studentId: string };
  refundProviderId: string;
  /** The caller's Override row, written inside the same transaction. */
  audit: (tx: Tx) => Promise<unknown>;
  now?: Date;
}): Promise<{ applied: boolean }> {
  const now = args.now ?? new Date();
  const notificationIds: string[] = [];

  const applied = await prisma.$transaction(async (tx) => {
    // Guarded on `status: "paid"` so a concurrent second refund (web + mobile,
    // a double submit, or a webhook that beat us here) is a no-op rather than
    // a duplicate audit row and a duplicate pair of notifications. Stripe's
    // own idempotency key already collapses the money movement.
    const flipped = await tx.payment.updateMany({
      where: { id: args.payment.id, status: "paid" },
      data: {
        status: "refunded",
        refundedAt: now,
        refundProviderId: args.refundProviderId,
      },
    });
    if (flipped.count === 0) return false;

    await tx.package.update({
      where: { id: args.package.id },
      data: { status: "refunded" },
    });

    await args.audit(tx);

    // Slice 2b clawback: a refunded purchase must not keep having qualified a
    // referral, so void the referrer's reward while it is still unredeemed.
    await voidReferralRewardForPayment(tx, args.payment.id);

    notificationIds.push(
      await enqueueRefundIssuedStudent(tx, {
        teacherId: args.package.teacherId,
        studentId: args.package.studentId,
        paymentId: args.payment.id,
      }),
    );
    notificationIds.push(
      await enqueueRefundIssuedTeacher(tx, {
        teacherId: args.package.teacherId,
        paymentId: args.payment.id,
      }),
    );
    return true;
  });

  if (!applied) return { applied: false };

  // After the commit, so nothing is dispatched for a rolled-back insert.
  // Best-effort, like every other emit site: the row is queued either way and
  // `emitNotificationQueued` swallows and logs its own failures.
  for (const notificationId of notificationIds) {
    await emitNotificationQueued({ notificationId, teacherId: args.package.teacherId });
  }

  return { applied: true };
}
