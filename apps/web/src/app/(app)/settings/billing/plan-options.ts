import {
  PLAN_INTERVAL,
  PLAN_PRICE_MINOR_UNITS,
  PLATFORM_MONEY_CURRENCY,
  type SubscriptionPlan,
} from "@spiralclass/shared";
import type { AppLocale } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { formatMinorUnits } from "@/lib/money";
import { formatDateInZone } from "@/lib/tz";
import { planLabel } from "@/lib/subscriptions/display";

// The plans on offer, as data.
//
// Extracted from the page so the two decisions in here — WHICH plan is
// recommended, and what an annual price works out at per month — are unit
// testable without rendering anything. Both are derived from the price table
// rather than written down: a hardcoded "Best value" badge on Annual is a
// claim about a table that can change without anyone remembering this file
// exists, which is the same reason "~2 months free" was replaced by a computed
// saving.
//
// Prices are always the platform currency and always the LIST price — these
// are new checkouts, deliberately not the caller's own locked price (which the
// summary card shows instead).

export type PlanOption = {
  plan: Exclude<SubscriptionPlan, "free">;
  priceLabel: string;
  intervalLabel: string;
  title: string;
  subtitle: string;
  /** What a plan billed less often than monthly works out at per month. */
  equivalentLabel?: string;
  /** Scarcity or savings — rendered as a badge, so keep it to a few words. */
  highlight?: string;
  highlightTone?: "info" | "warning";
  /** A second line under the badge, e.g. the founding cohort's cutoff date. */
  footnote?: string;
  /**
   * The one option to give visual precedence. At most one option carries it:
   * three cards with identical weight and three identical primary buttons ask
   * the reader to do the comparison the page should have done for her.
   */
  recommended?: boolean;
};

/**
 * The cheapest plan per month, which is the one worth recommending.
 *
 * Founding wins whenever the cohort is open — it is both the lowest monthly
 * figure and the only one locked for life — and Annual otherwise, but only
 * while it genuinely undercuts Monthly. Returns null when nothing does, so a
 * price table that changed underneath us degrades to three equal cards rather
 * than to a badge that lies.
 */
export function recommendedPlan(foundingOpen: boolean): Exclude<SubscriptionPlan, "free"> | null {
  const monthly = PLAN_PRICE_MINOR_UNITS.monthly;
  if (foundingOpen && PLAN_PRICE_MINOR_UNITS.founding < monthly) return "founding";
  if (perMonthMinorUnits("annual") < monthly) return "annual";
  return null;
}

/**
 * A plan's price expressed per month, in integer minor units.
 *
 * Rounded rather than truncated, and computed in minor units throughout — a
 * float division into major units is exactly the "never store or compare money
 * as a float" rule this codebase keeps. Monthly plans are returned unchanged.
 */
export function perMonthMinorUnits(plan: Exclude<SubscriptionPlan, "free">): number {
  return PLAN_INTERVAL[plan] === "year"
    ? Math.round(PLAN_PRICE_MINOR_UNITS[plan] / 12)
    : PLAN_PRICE_MINOR_UNITS[plan];
}

export function planOptions({
  t,
  locale,
  cohort,
  timezone,
}: {
  t: TFunction;
  locale: AppLocale;
  cohort: { isOpen: boolean; headcount: number; cap: number; cutoffAt: Date };
  timezone: string;
}): PlanOption[] {
  // Derived, never written down: twelve monthly charges against one annual
  // one. A hardcoded "~2 months free" was a claim about a price table that can
  // change without anyone remembering this string exists.
  const annualSaving = PLAN_PRICE_MINOR_UNITS.monthly * 12 - PLAN_PRICE_MINOR_UNITS.annual;
  const recommended = recommendedPlan(cohort.isOpen);

  // The interval word comes from PLAN_INTERVAL rather than from the plan name,
  // so a plan whose billing period changes cannot leave a stale "per month"
  // beside its price.
  const intervalLabel = (plan: Exclude<SubscriptionPlan, "free">) =>
    PLAN_INTERVAL[plan] === "year"
      ? t("web.settings.billing.interval.annual")
      : t("web.settings.billing.interval.monthly");

  const priceLabel = (plan: Exclude<SubscriptionPlan, "free">) =>
    formatMinorUnits(PLAN_PRICE_MINOR_UNITS[plan], PLATFORM_MONEY_CURRENCY);

  const options: PlanOption[] = [
    {
      plan: "monthly",
      priceLabel: priceLabel("monthly"),
      intervalLabel: intervalLabel("monthly"),
      title: planLabel("monthly", locale),
      subtitle: t("web.settings.billing.billedMonthly"),
    },
    {
      plan: "annual",
      priceLabel: priceLabel("annual"),
      intervalLabel: intervalLabel("annual"),
      title: planLabel("annual", locale),
      subtitle: t("web.settings.billing.billedAnnually"),
      // The figure that makes an annual price comparable to a monthly one at
      // a glance. Only rendered when it actually undercuts Monthly, so it can
      // never read as a saving that isn't there.
      equivalentLabel:
        perMonthMinorUnits("annual") < PLAN_PRICE_MINOR_UNITS.monthly
          ? t("web.settings.billing.perMonth", {
              amount: formatMinorUnits(perMonthMinorUnits("annual"), PLATFORM_MONEY_CURRENCY),
            })
          : undefined,
      highlight:
        annualSaving > 0
          ? t("web.settings.billing.annualSaving", {
              amount: formatMinorUnits(annualSaving, PLATFORM_MONEY_CURRENCY),
            })
          : undefined,
    },
  ];

  // Founding is offered only while the cohort is genuinely open, and says how
  // open: a scarcity claim with no number behind it is the kind a reader
  // discounts, and this one has a real count and a real cutoff.
  if (cohort.isOpen) {
    const spotsLeft = Math.max(0, cohort.cap - cohort.headcount);
    options.push({
      plan: "founding",
      priceLabel: priceLabel("founding"),
      intervalLabel: intervalLabel("founding"),
      title: planLabel("founding", locale),
      subtitle: t("web.settings.billing.priceLockedForLife"),
      highlight: t("web.settings.billing.foundingSpots", { count: spotsLeft }),
      highlightTone: "warning",
      footnote: t("web.settings.billing.foundingCloses", {
        date: formatDateInZone(cohort.cutoffAt, timezone, locale),
      }),
    });
  }

  return options.map((opt) => (opt.plan === recommended ? { ...opt, recommended: true } : opt));
}
