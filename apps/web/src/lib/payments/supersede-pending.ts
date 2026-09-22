import type { Prisma, PrismaClient } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import type { StripeClient } from "@/lib/stripe";

// Cross-rail double-charge guard (audit MED-4).
//
// Each `createCheckoutIntent` call mints a fresh pending Package + Payment.
// Without this, a student can open a Stripe checkout, abandon it, then open
// a Wise checkout (or just double-submit the form) for the same purchase —
// two payable rails for one intent. If they pay both, they're double-charged
// and the teacher has to refund one by hand.
//
// Before creating the new intent we supersede every still-pending purchase
// the same student has for the same template under this teacher:
//   * Stripe rows: expire the Checkout Session on Stripe's side so it can no
//     longer be paid (a session stays payable for ~24h otherwise), then mark
//     the package `expired`. Expiring the session is the load-bearing step —
//     it's what actually prevents a late payment.
//   * Wise rows: mark the package `expired`. There's no hosted session to
//     cancel; the reference simply stops being offered. A teacher who later
//     receives that transfer reconciles it manually as before.
//   * EXCEPT Wise rows the student already marked as sent ("Ya envié el
//     pago"): money may genuinely be in flight, and confirming a payment on
//     a superseded package would strand it (activatePackage only touches
//     `pending` rows). Those checkouts are left for the teacher to confirm
//     or fail explicitly.
//
// Best-effort + idempotent: a Stripe `expire` on an already-expired/paid
// session 400s, which we swallow (the row is left alone so a genuinely-paid
// session is still honored by the webhook). We never touch a package whose
// payment already settled.

type Db = Pick<PrismaClient, "package" | "payment">;

export type SupersedeDeps = {
  prisma: Db | Prisma.TransactionClient;
  // Lazily resolved so a Wise-only deploy (no Stripe creds) never
  // constructs a client unless there's actually a session to expire.
  getStripe: () => StripeClient;
  now?: () => Date;
};

export type SupersedeOutcome = {
  superseded: number;
};

export async function supersedePendingCheckouts(
  params: { teacherId: string; studentId: string; templateId: string },
  deps: SupersedeDeps,
): Promise<SupersedeOutcome> {
  const stale = await deps.prisma.package.findMany({
    where: {
      teacherId: params.teacherId,
      studentId: params.studentId,
      templateId: params.templateId,
      status: "pending",
      // Only supersede when nothing on the package has settled — every
      // payment must still be pending, and there must be at least one
      // (the `some` clause guards against Prisma's vacuous-truth `every`,
      // which would otherwise match a stray package with no payments).
      // A student-marked-sent Wise payment means money may be in flight:
      // never supersede those (see module header).
      payments: {
        some: { status: "pending" },
        every: { status: "pending" },
        none: { studentMarkedSentAt: { not: null } },
      },
    },
    select: {
      id: true,
      // The session lives on the TEACHER's connected account since D-143, so
      // expiring it needs her account id — a platform-scoped expire 404s and
      // would leave a live session able to take a late payment.
      teacher: { select: { stripeAccountId: true } },
      payments: {
        select: { id: true, provider: true, stripeCheckoutSessionId: true },
      },
    },
  });

  let superseded = 0;
  for (const pkg of stale) {
    // Expire any open Stripe Checkout Sessions first — this is what stops a
    // late payment. If it throws (already expired/paid/unknown), leave the
    // whole package untouched so we never orphan a session that could still
    // pay.
    let safeToExpire = true;
    for (const pay of pkg.payments) {
      if (pay.provider === "stripe" && pay.stripeCheckoutSessionId) {
        try {
          await deps
            .getStripe()
            .expireCheckoutSession(
              pay.stripeCheckoutSessionId,
              pkg.teacher.stripeAccountId ?? undefined,
            );
        } catch {
          // A 400 means the session already resolved (expired or — worst
          // case — paid). Don't expire the package; let the webhook settle
          // it normally.
          safeToExpire = false;
          Sentry.addBreadcrumb({
            category: "payments",
            level: "warning",
            message: "supersede: expireCheckoutSession failed; leaving package",
            data: { paymentId: pay.id },
          });
          break;
        }
      }
    }
    if (!safeToExpire) continue;

    await deps.prisma.package.update({
      where: { id: pkg.id },
      data: { status: "expired" },
    });
    superseded += 1;
  }

  return { superseded };
}
