// Cancellation rule classifier — pure, no DB.
// Source of truth: the pre-launch spec.
//
// The 24h boundary is an absolute UTC delta against `scheduledStart` — not
// `scheduledEnd` — so timezone is irrelevant here.
//
// Server is the source of truth (server-authoritative) — never call this with a client
// clock; pass `new Date()` from a server action only.

const MS_PER_HOUR = 60 * 60 * 1000;

export type CancelTiming = "lt24h" | "gte24h";

export type CancelClassification = {
  timing: CancelTiming;
  // Whether the rule layer would let the student reschedule. Tied to the
  // ≥24h branch by the 24-hour cancellation rule (cancel <24h → class lost, no reschedule path).
  eligibleForReschedule: boolean;
  // Per the 24-hour cancellation rule the lt24h branch deducts a class from the package.
  deductsClass: boolean;
};

export function classifyStudentCancel(input: {
  now: Date;
  scheduledStart: Date;
}): CancelClassification {
  const deltaMs = input.scheduledStart.getTime() - input.now.getTime();
  // Boundary semantics: exactly 24h = ≥24h (eligible). 23h59m59.999 = lt24h.
  const isGte24h = deltaMs >= 24 * MS_PER_HOUR;
  return isGte24h
    ? { timing: "gte24h", eligibleForReschedule: true, deductsClass: false }
    : { timing: "lt24h", eligibleForReschedule: false, deductsClass: true };
}

export type RescheduleEligibility = { ok: true } | { ok: false; reason: RescheduleReject };

export type RescheduleReject = "booking-not-scheduled" | "schedule-changes-exhausted" | "lt24h";

// The package's pooled "schedule change" allowance: one move per class.
//
// Both a reschedule and a ≥24h (refundable) student cancel draw from this same
// budget (see decideStudentCancel + the reschedule handler). Pooling the two is
// what closes the old loophole: when the cap lived on the booking row
// (reschedule_count < 1), a student could cancel ≥24h — refunding the class —
// then book a fresh row that started over at 0, giving unlimited free moves.
// A per-package budget that cancels also consume makes cancel→rebook cost the
// same single unit as a reschedule.
export function scheduleChangeBudget(classesTotal: number): number {
  return classesTotal;
}

// Composes the reschedule rules a student can satisfy without a teacher
// override:
//   1. Booking is still in `scheduled` (already-canceled, completed, etc. need override)
//   2. The package still has schedule-change budget left
//   3. ≥24h before scheduled_start
//
// The *new* slot's own constraints (availability, advance limits, package
// expiry) are checked by the reschedule action — this function only governs
// whether the user can enter the reschedule flow at all.
export function canStudentRescheduleBooking(input: {
  now: Date;
  scheduledStart: Date;
  status: string;
  scheduleChangesUsed: number;
  scheduleChangesAllowed: number;
}): RescheduleEligibility {
  if (input.status !== "scheduled") {
    return { ok: false, reason: "booking-not-scheduled" };
  }
  if (input.scheduleChangesUsed >= input.scheduleChangesAllowed) {
    return { ok: false, reason: "schedule-changes-exhausted" };
  }
  const c = classifyStudentCancel({
    now: input.now,
    scheduledStart: input.scheduledStart,
  });
  if (!c.eligibleForReschedule) {
    return { ok: false, reason: "lt24h" };
  }
  return { ok: true };
}

export type StudentCancelDecision = {
  timing: CancelTiming;
  // ≥24h AND budget left → release the slot back to the package (refund) and
  // spend one schedule-change unit. <24h is always a forfeit and never charges
  // the budget (it's already a penalty, not a "free" move).
  refundsClass: boolean;
  chargesScheduleChange: boolean;
  // ≥24h but the budget is spent: the refundable cancel is the last free-move
  // primitive (cancel→rebook), so block it here rather than hand back a class
  // the student could re-book for free. They can still forfeit (<24h / no-show)
  // or ask the teacher. <24h is never blocked.
  blockedExhausted: boolean;
};

// Decides what a student-initiated cancel does, given the package's
// schedule-change budget. Pure — the handler applies the mutations.
export function decideStudentCancel(input: {
  now: Date;
  scheduledStart: Date;
  scheduleChangesUsed: number;
  scheduleChangesAllowed: number;
}): StudentCancelDecision {
  const c = classifyStudentCancel({
    now: input.now,
    scheduledStart: input.scheduledStart,
  });
  if (c.deductsClass) {
    // <24h: forfeit (the penalty). Always allowed, never a schedule change.
    return {
      timing: c.timing,
      refundsClass: false,
      chargesScheduleChange: false,
      blockedExhausted: false,
    };
  }
  // ≥24h: a refundable cancel is a schedule change — gate it on the budget.
  const exhausted = input.scheduleChangesUsed >= input.scheduleChangesAllowed;
  return {
    timing: c.timing,
    refundsClass: !exhausted,
    chargesScheduleChange: !exhausted,
    blockedExhausted: exhausted,
  };
}
