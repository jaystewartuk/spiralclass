// Booking auto-complete: once `scheduled_end` passes, transition a still-
// `scheduled` booking to `completed`. Idempotent so Inngest retries are safe.
//
// Model B: the class was already counted against the package at reservation
// (it stays counts_against_package = true through completion), so this path
// no longer touches classes_used — completing a class is quota-neutral.
//
// Pure data-layer helper — no Inngest, no env reads — so unit tests can
// pass an in-memory client without standing up the full app environment.
// Driven by the auto-complete-sweep cron (the per-booking sleeper wrapper was
// deleted in Phase 2b-ii; the sweep is now the sole completion path).

import { prisma } from "@/lib/prisma";

export type AutoCompleteClient = {
  $transaction: <T>(fn: (tx: AutoCompleteTx) => Promise<T>) => Promise<T>;
};
export type AutoCompleteTx = {
  booking: {
    updateMany: (args: {
      where: { id: string; teacherId: string; status: string };
      data: { status: string; completedAt: Date };
    }) => Promise<{ count: number }>;
  };
};

export async function maybeCompleteBooking(
  input: {
    bookingId: string;
    teacherId: string;
    packageId: string;
    now?: Date;
  },
  client: AutoCompleteClient = prisma as unknown as AutoCompleteClient,
): Promise<{ completed: boolean; reason?: string }> {
  const now = input.now ?? new Date();
  return client.$transaction(async (tx) => {
    const upd = await tx.booking.updateMany({
      where: {
        id: input.bookingId,
        teacherId: input.teacherId,
        status: "scheduled",
      },
      data: { status: "completed", completedAt: now },
    });
    if (upd.count === 0) {
      return { completed: false, reason: "not-scheduled" };
    }
    return { completed: true };
  });
}
