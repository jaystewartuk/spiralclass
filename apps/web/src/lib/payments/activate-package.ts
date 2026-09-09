import type { Prisma } from "@prisma/client";
import { addMonthsEndOfDayInZone } from "@/lib/dates";

// Single source of truth for activating a pending package. Both the Stripe
// webhook handler and the Wise manual-confirm path settle a payment by
// flipping its package to `active`. This used to be duplicated inline in each
// (with a comment noting it was copied to dodge a circular dependency); the
// logic lives here instead so the two rails can never drift.
//
// Sets status=active, locks `purchasedAt`, and computes `expiresAt` from the
// template's `expirationMonths` (if any), end-of-day in the teacher's zone.
// Idempotent: a non-pending package is left untouched.
export async function activatePackage(
  tx: Prisma.TransactionClient,
  packageId: string,
  now: Date,
): Promise<void> {
  const pkg = await tx.package.findUnique({
    where: { id: packageId },
    include: {
      template: { select: { expirationMonths: true } },
      teacher: { select: { timezone: true } },
    },
  });
  if (!pkg) return;
  if (pkg.status !== "pending") return;

  const months = pkg.template?.expirationMonths ?? null;
  const expiresAt = months ? addMonthsEndOfDayInZone(now, months, pkg.teacher.timezone) : null;

  await tx.package.update({
    where: { id: packageId },
    data: { status: "active", purchasedAt: now, expiresAt },
  });

  // The acquisition funnel's terminal `purchase` event (D-125) is recorded by
  // the CALLER, after this transaction commits — never inside it. A failed
  // statement poisons a Postgres transaction even when its JavaScript error is
  // caught, so an analytics insert in here could roll back a settled payment.
  // Both rails call recordPurchaseForActivation() once they are committed.
}
