import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { trackServerEvent } from "@/lib/analytics/posthog";

// "First booking/payment received" —
// derived with a plain count check at the same call sites that already emit
// `booking_created`/`payment_received`, not a separately-gated write. This is
// an analytics-only signal, so the rare double-fire under a concurrent race
// (two of a brand-new teacher's bookings landing at the exact same instant)
// is an acceptable blemish, not a correctness bug — contrast
// lib/marketplace-ready.ts, which guards a real one-time state transition.

/** Fires `first_booking_received` the moment a teacher's booking count hits 1. */
export async function maybeEmitFirstBooking(teacherId: string, bookingId: string): Promise<void> {
  const count = await prisma.booking.count({ where: { teacherId } });
  if (count !== 1) return;
  trackServerEvent({
    name: "first_booking_received",
    distinctId: teacherId,
    properties: { teacherId, bookingId },
  });
}

/**
 * Fires `first_payment_received` the moment a teacher's paid-payment count
 * hits 1. Takes an injected prisma client (rather than importing the global
 * singleton, like maybeEmitFirstBooking does) because its two call sites
 * (webhook-handler.ts, wise-confirm.ts) already receive Prisma via a `deps`
 * param for testability — importing the singleton here would silently bypass
 * their test doubles and hit a real, unconfigured Prisma client instead.
 */
export async function maybeEmitFirstPayment(
  prismaClient: Pick<PrismaClient, "payment">,
  teacherId: string,
  paymentId: string,
): Promise<void> {
  const count = await prismaClient.payment.count({
    where: { status: "paid", package: { teacherId } },
  });
  if (count !== 1) return;
  trackServerEvent({
    name: "first_payment_received",
    distinctId: teacherId,
    properties: { teacherId, paymentId },
  });
}
