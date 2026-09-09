import type { PrismaClient } from "@prisma/client";
import { advancePayment, type PaymentSnapshot } from "./state";
import { enqueuePaymentReceived, enqueuePaymentReceivedTeacher } from "@/lib/notifications/enqueue";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { maybeEmitFirstPayment } from "@/lib/analytics/first-events";
import { activatePackage } from "./activate-package";
import { recordPurchaseForActivation } from "@/lib/marketing/events";
import { logger } from "@/lib/logger";
import type { WebhookEventEmitter } from "./webhook-handler";

const log = logger({ surface: "wise-confirm" });

// Wise confirmation pipeline.
//
// Wise has no public API for "did this transfer land?" without a per-teacher
// API token, so reconciliation defaults to teacher-confirmed: the teacher
// looks at their Wise app, sees the transfer, and clicks "Mark as paid"
// on the payment detail page. This module handles the side effects:
//   * advances the payment state machine via the same `advancePayment`
//     reducer that Stripe uses (so the activate/notify/track surface is
//     identical regardless of provider),
//   * activates the package,
//   * enqueues `payment_received` notification,
//   * emits Inngest events (`notification.queued`, `payment.paid`),
//   * tracks `payment_received` in PostHog with `kind: "wise"`.
//
// The `confirmedByTeacherId` is recorded for audit. The automated
// balance-statement reconciler (poll-wise-statements cron) calls this with
// `confirmedByTeacherId = null`; that flips the row's bookkeeping to the
// auto path — `autoMatchedAt` is stamped, `confirmedBy` stays null,
// and the override action becomes `wise_auto_confirm`. Everything else
// (state-machine flip, package activation, notify, emit, track) is shared.

export type TransferConfirmDeps = {
  prisma: Pick<PrismaClient, "payment" | "package" | "$transaction" | "override">;
  now?: () => Date;
  emit?: WebhookEventEmitter;
};

export type TransferConfirmInput = {
  paymentId: string;
  // The teacher who clicked the button. The action layer checks tenancy
  // before calling, so this id is trusted. `null` means the automated
  // reconciler matched the payment off the balance statement (no human in
  // the loop) — see the module header.
  confirmedByTeacherId: string | null;
  // Optional free-text note recorded as the override `reason`.
  note?: string;
};

export type TransferConfirmOutcome =
  | { code: "applied"; paymentId: string; packageId: string }
  | { code: "not-found" }
  | { code: "wrong-provider"; provider: string }
  | { code: "already-paid" }
  | { code: "already-refunded" }
  | { code: "already-failed" };

export async function confirmTransferPayment(
  input: TransferConfirmInput,
  deps: TransferConfirmDeps,
): Promise<TransferConfirmOutcome> {
  const payment = await deps.prisma.payment.findUnique({
    where: { id: input.paymentId },
    include: {
      package: {
        select: {
          id: true,
          teacherId: true,
          studentId: true,
          templateId: true,
          status: true,
        },
      },
    },
  });
  if (!payment) return { code: "not-found" };
  if (payment.provider !== "manual_transfer") {
    return { code: "wrong-provider", provider: payment.provider };
  }
  if (payment.status === "paid") return { code: "already-paid" };
  if (payment.status === "refunded") return { code: "already-refunded" };
  if (payment.status === "failed") return { code: "already-failed" };

  const now = (deps.now ?? (() => new Date()))();

  // Reuse the canonical state-machine reducer so Stripe/Wise paths
  // converge on identical flip-paid semantics. We synthesize a Stripe-
  // shaped `succeeded` outcome — Wise doesn't have a payment_intent id,
  // so we pass a synthetic id purely to satisfy the reducer's typed
  // input. It is NOT persisted: `providerPaymentId` is the Stripe
  // PaymentIntent column, and writing the paymentReference there made
  // the admin UI treat a Wise row as a Stripe charge (rendering the
  // "Stripe ↗" link and a refund button that Stripe would reject).
  const snapshot: PaymentSnapshot = {
    status: payment.status,
    amountMinorUnits: payment.amountMinorUnits,
    currency: payment.currency,
    rail: payment.rail,
    providerPaymentId: payment.providerPaymentId,
    paidAt: payment.paidAt,
    refundedAt: payment.refundedAt,
  };
  const result = advancePayment(
    snapshot,
    {
      kind: "succeeded",
      paymentIntentId: payment.paymentReference ?? `wise-${payment.id}`,
      amountReceivedMinorUnits: payment.amountMinorUnits,
      // Wise transfers are reconciled by manual teacher confirmation against the
      // row itself, so the "settled" currency is exactly the row's expected
      // currency — the guard always matches (MXN today, whatever the row is
      // priced in tomorrow).
      currency: payment.currency.toLowerCase(),
      rail: "wise",
    },
    now,
  );
  // Defensive: any "noop" or non flip-paid result here means our state
  // checks above missed something. We return a generic already-paid so
  // the UI can render the same "nothing to do" copy.
  if (result.action !== "flip-paid") {
    return { code: "already-paid" };
  }

  // `confirmedByTeacherId === null` is the automated-reconciler path. We
  // record the two confirmation sources differently so the override log
  // and the payment row both stay auditable.
  const isAuto = input.confirmedByTeacherId === null;

  const queuedNotificationIds: string[] = [];
  let lostRace = false;

  // A superseded checkout: the student re-submitted the buy form after
  // (actually) sending the Wise transfer, so supersede marked the package
  // `expired` while the money was in flight. The transfer being confirmed
  // proves the purchase is real — un-supersede so activatePackage (which
  // only touches `pending` rows) doesn't silently no-op and strand the
  // student's paid-for classes.
  const unsupersede = payment.package.status === "expired";

  await deps.prisma.$transaction(async (tx) => {
    // Guarded flip: the teacher's confirm can race the auto-reconciler (or a
    // double-click from a stale tab). Both callers pass the status check
    // above; only the one whose conditional update matches the pre-read
    // status applies the side effects — the loser rolls up as already-paid.
    const flipped = await tx.payment.updateMany({
      where: { id: payment.id, status: payment.status },
      data: {
        status: result.next.status,
        rail: result.next.rail,
        // providerPaymentId stays null for Wise — it's the Stripe
        // PaymentIntent column (see the synthetic-outcome note above).
        providerPaymentId: payment.providerPaymentId,
        paidAt: result.next.paidAt,
        confirmedBy: input.confirmedByTeacherId,
        confirmedAt: now,
        autoMatchedAt: isAuto ? now : null,
      },
    });
    if (flipped.count === 0) {
      lostRace = true;
      return;
    }
    if (unsupersede) {
      await tx.package.updateMany({
        where: { id: payment.package.id, status: "expired" },
        data: { status: "pending" },
      });
    }
    await activatePackage(tx, payment.package.id, now);
    queuedNotificationIds.push(
      await enqueuePaymentReceived(tx, {
        teacherId: payment.package.teacherId,
        studentId: payment.package.studentId,
        paymentId: payment.id,
        packageId: payment.package.id,
      }),
    );
    // Teacher receipt, but ONLY on the automated-reconciler path. The Stripe
    // handler always sends one because a card sale happens with no teacher
    // involvement at all; here, a manual confirm means the teacher is the one
    // who just pressed the button, so telling her about it is pure noise. The
    // auto path (poll-wise-statements → wise-reconcile, confirmedByTeacherId
    // null) is the real gap: the money lands, the package activates and the
    // student is notified, while the teacher is told nothing.
    if (isAuto) {
      queuedNotificationIds.push(
        await enqueuePaymentReceivedTeacher(tx, {
          teacherId: payment.package.teacherId,
          paymentId: payment.id,
        }),
      );
    }
    await tx.override.create({
      data: {
        teacherId: payment.package.teacherId,
        targetType: "payment",
        targetId: payment.id,
        action: isAuto ? "wise_auto_confirm" : "wise_confirm",
        reason:
          input.note ??
          (isAuto
            ? "Wise transferencia conciliada automáticamente (statement)"
            : "Wise transferencia confirmada por la profe"),
        beforeJson: { status: payment.status },
        afterJson: {
          status: "paid",
          rail: "wise",
          confirmedBy: input.confirmedByTeacherId,
          auto: isAuto,
          ...(unsupersede ? { unsuperseded: true } : {}),
        },
      },
    });
  });

  if (lostRace) return { code: "already-paid" };

  // Acquisition funnel terminal step (D-125), after the transaction committed —
  // never inside it (see activatePackage). Same call as the Stripe rail so the
  // two can't disagree about what a purchase is worth.
  await recordPurchaseForActivation(payment.package.id);

  const emit = deps.emit;
  if (emit) {
    for (const notificationId of queuedNotificationIds) {
      try {
        await emit({
          name: "notification.queued",
          data: {
            notificationId,
            teacherId: payment.package.teacherId,
          },
        });
      } catch (err) {
        // Per-notification catch: a failed student receipt must not stop the
        // teacher one (or payment.paid below) from being emitted.
        log.error("emit notification.queued failed", err, { notificationId });
      }
    }
    try {
      await emit({
        name: "payment.paid",
        data: {
          paymentId: payment.id,
          packageId: payment.package.id,
          teacherId: payment.package.teacherId,
          studentId: payment.package.studentId,
        },
      });
    } catch (err) {
      log.error("emit payment.paid failed", err);
    }
  }

  trackServerEvent({
    name: "payment_received",
    distinctId: payment.package.studentId,
    sessionId: payment.posthogSessionId ?? undefined,
    properties: {
      teacherId: payment.package.teacherId,
      packageId: payment.package.id,
      paymentId: payment.id,
      // `kind` distinguishes wise from stripe; the manual-vs-auto split is
      // recorded on the payment row (autoMatchedAt) and the override log
      // rather than widening the typed analytics event.
      kind: "wise",
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
    },
  });
  await maybeEmitFirstPayment(deps.prisma, payment.package.teacherId, payment.id);

  return {
    code: "applied",
    paymentId: payment.id,
    packageId: payment.package.id,
  };
}
