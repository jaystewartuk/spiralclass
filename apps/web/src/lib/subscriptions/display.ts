import { createT } from "@spiralclass/shared";
import type { AppLocale } from "@/lib/i18n";
import { formatMinorUnits } from "@/lib/money";
import { PLATFORM_MONEY_CURRENCY } from "@spiralclass/shared";
import { PLAN_PRICE_MINOR_UNITS, type SubscriptionPlan, type SubscriptionStatus } from "./config";

// Localized display strings for plans + statuses. Shared by the settings/billing
// page, the pricing page and the admin overview so the labels never drift.
//
// These resolve through the shared CATALOG now. They used to be inline
// `locale === "en" ? english : spanish` ternaries, which is a two-locale shape
// in a three-locale product: `fr` is not `en`, so it took the other branch and
// a French teacher's plan read "Pro Mensual" and her status "Pago vencido".
// The registry has had three locales since French was added; nothing pointed
// this out because a ternary compiles fine at any number of them.
//
// `createT` is built per call rather than threaded through every signature:
// it is a table lookup over an object literal, and keeping the
// `(value, locale)` signatures meant the four call sites did not have to
// change to get the fix.

export function planLabel(plan: SubscriptionPlan, locale: AppLocale): string {
  return createT(locale)(`subscriptions.plan.${plan}`);
}

export function statusLabel(status: SubscriptionStatus, locale: AppLocale): string {
  return createT(locale)(`subscriptions.status.${status}`);
}

// "£7.99 GBP/mo" style price string for a plan — the CURRENT canonical
// (new-checkout) price, never a specific existing subscriber's own locked
// price (use formatMinorUnits(sub.lockedPriceMinorUnits, sub.currency) for that —
// see settings/billing/plan-summary.tsx).
//
// The suffix is GLUED to the amount, which is what the pricing page's inline
// prose wants. Somewhere rendering the price as a headline should format the
// amount itself and put the interval beside it as its own word — see
// settings/billing, where "/mo" at display size reads as part of the number.
export function planPriceLabel(plan: SubscriptionPlan, locale: AppLocale): string {
  const t = createT(locale);
  const amount = formatMinorUnits(PLAN_PRICE_MINOR_UNITS[plan], PLATFORM_MONEY_CURRENCY);
  switch (plan) {
    case "free":
      return t("subscriptions.plan.free");
    case "monthly":
    case "founding":
      return `${amount}${t("subscriptions.priceSuffix.month")}`;
    case "annual":
      return `${amount}${t("subscriptions.priceSuffix.year")}`;
  }
}
