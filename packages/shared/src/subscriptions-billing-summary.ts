// What the date on a teacher's billing page MEANS.
//
// `teacher_subscriptions` carries three dates — `trialEndsAt`,
// `currentPeriodEnd`, `canceledAt` — and, since the cancel-at-period-end
// column, one flag. Which of them is the date to show, and what to call it,
// depends on a combination the UI had been re-deriving inline and getting
// wrong: a subscription cancelled in the Stripe Customer Portal stays `active`
// with `currentPeriodEnd` in the future, and the billing page rendered that as
// "Next charge" — announcing a charge that will never happen to the one
// teacher guaranteed to be looking for exactly this information.
//
// So the decision lives here, once, as a pure function: the same resolver
// answers the settings page, the persistent app banner, and anything that
// comes later. It deliberately returns a DISPOSITION plus a date rather than a
// pre-formatted string, because the caller owns the locale and the timezone.
//
// Pairs with `entitlementsFor` (subscriptions-entitlements.ts) rather than
// duplicating it: that resolver answers "what can she do", this one answers
// "what happens next, and when". Both take the clock so a stale row cannot
// make either lie.

import { PAST_DUE_GRACE_DAYS } from "./subscriptions-config";
import { effectiveStatus, type SubscriptionLike } from "./subscriptions-entitlements";

// What is about to happen to this subscription.
//
//  * `renews`      — a paid plan that will bill again on `effectiveAt`.
//  * `ends`        — cancelled in the portal, still paid through `effectiveAt`.
//                    Pro until then, Free after. NOT the same as `none`.
//  * `trial_ends`  — the free trial runs out on `effectiveAt`.
//  * `grace_ends`  — a failed payment; access survives to the end of the
//                    past-due grace window and then drops.
//  * `none`        — nothing is scheduled: Free, comped, or a paid row with no
//                    period end for us to promise anything about.
export type BillingDisposition = "renews" | "ends" | "trial_ends" | "grace_ends" | "none";

export type BillingSummary = {
  disposition: BillingDisposition;
  // The date the disposition happens on. Null exactly when disposition is
  // "none" — the two are one fact, so a caller that narrows on the disposition
  // never has to null-check the date as well.
  effectiveAt: Date | null;
  // Whole days from `now` until `effectiveAt`, rounded UP so the last partial
  // day still reads as "1 day left" rather than "0". Never negative; null when
  // there is no date. Rounding up matches the trial banner this replaces.
  daysRemaining: number | null;
  // True when the teacher keeps Pro today but will not tomorrow-ish unless she
  // acts — the condition worth putting a banner or an accent behind. Comped
  // and healthy paid subscriptions are false.
  needsAttention: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(target: Date, now: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / DAY_MS));
}

function summary(
  disposition: Exclude<BillingDisposition, "none">,
  effectiveAt: Date,
  now: Date,
  needsAttention: boolean,
): BillingSummary {
  return {
    disposition,
    effectiveAt,
    daysRemaining: daysUntil(effectiveAt, now),
    needsAttention,
  };
}

const NOTHING_SCHEDULED: BillingSummary = {
  disposition: "none",
  effectiveAt: null,
  daysRemaining: null,
  needsAttention: false,
};

// The subset of the row this resolver reads: everything `entitlementsFor`
// needs, plus the pending-cancellation flag it does not (cancelling changes
// nothing about what she can do TODAY, which is why the two resolvers stay
// separate).
export type BillingSummaryInput =
  (NonNullable<SubscriptionLike> & { cancelAtPeriodEnd?: boolean }) | null;

export function billingSummary(sub: BillingSummaryInput, now: Date = new Date()): BillingSummary {
  if (!sub) return NOTHING_SCHEDULED;

  // Comped is checked before anything else, exactly as the entitlements
  // resolver does: a comped account is full Pro and is never billed, so every
  // date on the row is noise to it.
  if (sub.comped) return NOTHING_SCHEDULED;

  // The clock-corrected status, not the stored one — a trial that expired
  // before the sweep ran must not still be advertising a trial end date.
  const status = effectiveStatus(sub, now);

  if (status === "trialing" && sub.trialEndsAt) {
    return summary("trial_ends", sub.trialEndsAt, now, true);
  }

  if (status === "past_due") {
    // Access ends at the END of the grace window, not at the period end that
    // anchors it — the teacher is still Pro for those days and telling her
    // otherwise would be its own lie, in the opposite direction. Mirrors the
    // arithmetic in effectiveStatus so the date shown is the date it acts on.
    if (sub.currentPeriodEnd) {
      const graceEnd = new Date(sub.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
      return summary("grace_ends", graceEnd, now, true);
    }
    return { ...NOTHING_SCHEDULED, needsAttention: true };
  }

  if (status === "active" && sub.currentPeriodEnd) {
    return sub.cancelAtPeriodEnd
      ? summary("ends", sub.currentPeriodEnd, now, true)
      : summary("renews", sub.currentPeriodEnd, now, false);
  }

  // Free, canceled, or an active row Stripe has not given a period end for.
  return NOTHING_SCHEDULED;
}
