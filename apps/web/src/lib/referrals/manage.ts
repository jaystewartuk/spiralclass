import {
  currencyExponent,
  currencyForTeacher,
  DEFAULT_PRICING_CURRENCY,
  majorToMinorUnits,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";

// Teacher-facing management core for the student→student referral program
// (slice 2b): read + upsert the single per-teacher config. Input is already
// validated + typed by the caller. The minting/checkout core lives in
// ./index.ts.
//
// It was extracted from the web server action so a second caller could drive
// the identical write; that caller is gone and the web action is the only one
// now. Left extracted rather than folded back in — the split
// costs nothing and ./index.ts reads it too.

// One reward side (referred friend or referrer), as the teacher typed it.
export type ReferralRewardInput = {
  kind: "percent" | "fixed";
  // 1..100 when kind === "percent".
  percent?: number;
  // Pesos when kind === "fixed" (stored as centavos).
  amountPesos?: number;
};

export type ReferralProgramInput = {
  enabled: boolean;
  referred: ReferralRewardInput;
  referrer: ReferralRewardInput;
  // Days the minted reward stays valid (null = no expiry).
  rewardExpiryDays?: number | null;
};

// `currency` is the teacher's own pricing currency — required, not defaulted,
// because `majorToMinorUnits` falls back to MXN's 2-decimal exponent and would
// multiply a 0-decimal amount (CLP, JPY, KRW, VND) by 100.
function toCols(r: ReferralRewardInput, currency: string) {
  return {
    kind: r.kind,
    percentBps: r.kind === "percent" ? (r.percent as number) * 100 : null,
    amountMinorUnits:
      r.kind === "fixed" ? majorToMinorUnits(r.amountPesos as number, currency) : null,
  };
}

export async function saveReferralProgram(
  teacherId: string,
  input: ReferralProgramInput,
): Promise<void> {
  // Fixed reward amounts are denominated in the teacher's own chosen pricing
  // currency. The minted reward code inherits this, and — since the amounts
  // are converted from major units below — so does the conversion itself.
  const teacherRow = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { pricingCurrency: true },
  });
  const currency = currencyForTeacher(teacherRow ?? {});
  const rd = toCols(input.referred, currency);
  const rr = toCols(input.referrer, currency);
  const data = {
    enabled: input.enabled,
    referredKind: rd.kind,
    referredPercentBps: rd.percentBps,
    referredAmountMinorUnits: rd.amountMinorUnits,
    referrerKind: rr.kind,
    referrerPercentBps: rr.percentBps,
    referrerAmountMinorUnits: rr.amountMinorUnits,
    currency,
    rewardExpiryDays: input.rewardExpiryDays ?? null,
  };
  await prisma.referralProgram.upsert({
    where: { teacherId },
    create: { teacherId, ...data },
    update: data,
  });
}

export type ReferralProgramView = {
  enabled: boolean;
  referredKind: "percent" | "fixed";
  referredPercent: number | null;
  referredPesos: number | null;
  referrerKind: "percent" | "fixed";
  referrerPercent: number | null;
  referrerPesos: number | null;
  rewardExpiryDays: number | null;
  // Rewards earned so far — reassurance shown once the program is live.
  rewarded: number;
};

export async function getReferralProgram(teacherId: string): Promise<ReferralProgramView> {
  const program = await prisma.referralProgram.findUnique({ where: { teacherId } });
  const rewarded = await prisma.referral.count({
    where: { teacherId, status: "rewarded" },
  });
  // Minor units back to major units by the currency's OWN exponent, not /100.
  // `saveReferralProgram` writes through the currency-aware `majorToMinorUnits`,
  // so a hardcoded divisor here made the read the asymmetric half: a
  // 0-decimal currency (JPY, CLP, KRW, VND) came back as a hundredth of what
  // was saved, and re-submitting that prefilled form stored the hundredth.
  const divisor = 10 ** currencyExponent(program?.currency ?? DEFAULT_PRICING_CURRENCY);
  return {
    enabled: program?.enabled ?? false,
    referredKind: (program?.referredKind ?? "fixed") as "percent" | "fixed",
    referredPercent: program?.referredPercentBps ? program.referredPercentBps / 100 : null,
    referredPesos: program?.referredAmountMinorUnits
      ? program.referredAmountMinorUnits / divisor
      : null,
    referrerKind: (program?.referrerKind ?? "fixed") as "percent" | "fixed",
    referrerPercent: program?.referrerPercentBps ? program.referrerPercentBps / 100 : null,
    referrerPesos: program?.referrerAmountMinorUnits
      ? program.referrerAmountMinorUnits / divisor
      : null,
    rewardExpiryDays: program?.rewardExpiryDays ?? null,
    rewarded,
  };
}
