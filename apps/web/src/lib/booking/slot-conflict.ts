import { Prisma } from "@prisma/client";

// True when a booking write failed because it collided with another scheduled
// booking for the same teacher — the exact-start partial unique index
// (`bookings_teacher_slot_active_unique`, surfaced by Prisma as P2002), the
// plain interval-overlap EXCLUDE constraint (`bookings_no_overlap_active`),
// or the buffer-aware EXCLUDE constraint (`bookings_no_overlap_buffered`,
// migration 20260703020000, columns added in 20260703010000) — both EXCLUDE
// constraints raise Postgres error
// 23P01, which Prisma does not map to a P-code and surfaces as an
// unknown-request error carrying the constraint name in its message.
//
// All three mean the same thing to the user — "that slot is taken" (or "too
// close to another class") — so callers map any of them to the friendly
// slot-conflict path instead of a 500.
export function isSlotConflictError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("bookings_no_overlap_active") ||
    msg.includes("bookings_no_overlap_buffered") ||
    msg.includes("23P01") ||
    msg.includes("exclusion constraint")
  );
}
