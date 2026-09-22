import { handleTeacherCancel, type CancelDeps } from "./cancel-handler";

// Blocked dates collision-notify: when a teacher creates a new BlockedDate, any
// booking in `status='scheduled'` whose `scheduledStart` falls inside the
// new range gets flipped to `canceled_by_teacher` via the standard the 24-hour cancellation rule
// teacher-cancel path. That path:
//   1. Sets booking.status = 'canceled_by_teacher' (class restored — no
//      deduction, monthly quota untouched).
//   2. Logs an Override row keyed on the booking with the supplied reason
// so teacher overrides student-facing history shows why the class moved.
//   3. Enqueues the `teacher_cancel` notification template, which the
//      dispatcher renders as a reschedule prompt for the student.
//
// Pure-ish — no auth, no revalidate, no Inngest singleton. Server actions
// pass real Prisma + an Inngest-backed emitter; tests pass an in-memory
// fake + a recording emitter (mirrors the pattern used by handleTeacherCancel
// itself).

export type BlockedDateCollisionDeps = CancelDeps;

export type BlockedDateCollisionInput = {
  teacherId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
};

export type BlockedDateCollisionResult = {
  canceled: number;
  bookingIds: string[];
};

export async function notifyBookingsInBlockedRange(
  deps: BlockedDateCollisionDeps,
  input: BlockedDateCollisionInput,
): Promise<BlockedDateCollisionResult> {
  // True interval overlap, not just "starts inside the block": a class that
  // begins before the block but runs into it (block 14:00–…, class 13:30–14:30)
  // also collides and must be cancelled. Mirrors the read-time slot generator,
  // which already uses interval overlap. Overlap = starts before the block ends
  // AND ends after the block starts.
  const colliding = await deps.prisma.booking.findMany({
    where: {
      teacherId: input.teacherId,
      status: "scheduled",
      scheduledStart: { lt: input.endsAt },
      scheduledEnd: { gt: input.startsAt },
    },
    select: { id: true },
  });

  const reason = input.reason
    ? `Fecha bloqueada: ${input.reason}`
    : "Fecha bloqueada en tu calendario";

  // Cancel colliding bookings in bounded-concurrency batches rather than one
  // strictly-sequential await chain: a teacher blocking a wide range can hit
  // many classes, and each cancel is an independent transaction on a distinct
  // booking. The cap keeps us from exhausting the connection pool. Results are
  // collected in the original collision order for a deterministic response.
  const canceledIds: string[] = [];
  for (let i = 0; i < colliding.length; i += COLLISION_CANCEL_CONCURRENCY) {
    const batch = colliding.slice(i, i + COLLISION_CANCEL_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map((b) =>
        handleTeacherCancel(deps, {
          bookingId: b.id,
          teacherId: input.teacherId,
          reason,
        }).then((outcome) => ({ id: b.id, outcome })),
      ),
    );
    for (const { id, outcome } of outcomes) {
      if (outcome.code === "ok") canceledIds.push(id);
    }
  }

  return { canceled: canceledIds.length, bookingIds: canceledIds };
}

const COLLISION_CANCEL_CONCURRENCY = 5;
