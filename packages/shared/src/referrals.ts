import { majorToMinorUnits } from "./money";

// Pure referral arithmetic, shared so the teacher's live preview and the
// checkout that eventually charges her student agree on what a reward is
// worth.
//
// The authoritative resolver at checkout is `computeDiscountMinorUnits` in
// apps/web/src/lib/discounts — it reads a STORED code (percent in basis
// points, fixed in centavos). This reads the shape a teacher is TYPING
// (whole percent, major units), because a preview that waited for a save
// round-trip would not be a preview. The two must agree; a cross-check in
// apps/web/tests/lib/referrals.test.ts asserts they do, since that is the
// only place both are importable.

/** A reward side exactly as the teacher enters it: whole percent, or an
 * amount in her own pricing currency's major units. `null` = not filled in. */
export type ReferralRewardDraft = {
  kind: "percent" | "fixed";
  percent: number | null;
  amount: number | null;
};

/**
 * What a drafted reward takes off `baseMinorUnits`, or `null` when the teacher
 * has not entered the value for the kind she selected — the caller renders a
 * placeholder rather than a confident zero.
 *
 * Clamped to `[0, baseMinorUnits]` for the same reason the stored-code resolver
 * is: a fixed reward larger than the package must never produce a negative
 * charge, and a preview that showed one would be advertising a bug.
 */
export function previewRewardMinorUnits(
  reward: ReferralRewardDraft,
  baseMinorUnits: number,
  currency: string,
): number | null {
  if (baseMinorUnits <= 0) return null;
  if (reward.kind === "percent") {
    if (reward.percent == null || !Number.isFinite(reward.percent)) return null;
    return clamp(Math.round((baseMinorUnits * reward.percent) / 100), baseMinorUnits);
  }
  if (reward.amount == null || !Number.isFinite(reward.amount)) return null;
  return clamp(majorToMinorUnits(reward.amount, currency), baseMinorUnits);
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}
