import {
  AlertTriangle,
  CalendarClock,
  CalendarX,
  Gift,
  Infinity as InfinityIcon,
} from "lucide-react";
import type { TeacherSubscription } from "@prisma/client";
import {
  billingSummary,
  type BillingDisposition,
  type BillingSummary,
  PLAN_INTERVAL,
} from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Heading, Text } from "@/components/ui/heading";
import { openBillingPortal } from "@/app/actions/billing";
import type { AppLocale } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { formatMinorUnits } from "@/lib/money";
import { formatDateInZone } from "@/lib/tz";
import type { Entitlements } from "@/lib/subscriptions/entitlements";
import { planLabel } from "@/lib/subscriptions/display";

// The one card that answers "what am I on, what does it cost, and what happens
// next". Everything below it on the page is detail; this is the part a teacher
// opens the page to read.
//
// The third line is the reason this component exists rather than a stack of
// key/value rows. `currentPeriodEnd` alone does not say whether it is a
// renewal or an ending — a Customer Portal cancellation leaves the
// subscription `active` with the date untouched — so the disposition comes
// from the shared `billingSummary` resolver and the label follows it. The page
// used to read that date directly and always call it "Next charge", which told
// a teacher who had just cancelled that she was about to be billed again.
//
// A state needing action is rendered INSIDE this card on a tinted ground
// rather than as a separate Alert above it. One place to look: an alert that
// restates the card underneath it is two sources for one fact, and they drift.

type Tone = "neutral" | "warning" | "danger";

// Tone by disposition. Failed payment is the only genuinely destructive state
// — a trial running out or a subscription she chose to end are both expected,
// and painting them red trains the eye to ignore the colour that matters.
const TONE: Record<BillingDisposition, Tone> = {
  renews: "neutral",
  ends: "warning",
  trial_ends: "warning",
  grace_ends: "danger",
  none: "neutral",
};

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-muted/50 text-foreground",
  warning: "bg-warning-bg text-warning",
  danger: "bg-destructive-bg text-destructive",
};

export function PlanSummary({
  subscription,
  entitlements,
  locale,
  timezone,
  hasPortal,
  plansHref,
  t,
  now,
}: {
  subscription: TeacherSubscription;
  entitlements: Entitlements;
  locale: AppLocale;
  timezone: string;
  /** Whether a Stripe Customer Portal exists for this teacher (see page.tsx). */
  hasPortal: boolean;
  /**
   * Anchor to the plan chooser, when the page is rendering one. The card
   * carries the state; on Free and in trial it also has to carry the way out
   * of it — otherwise the one card a teacher actually reads ends with nothing
   * to do about what it just told her.
   */
  plansHref?: string;
  t: TFunction;
  now: Date;
}) {
  const summary = billingSummary(subscription, now);
  const date = summary.effectiveAt ? formatDateInZone(summary.effectiveAt, timezone, locale) : "";

  // Her OWN locked price when she has one — never the current list price. A
  // pre-D-99 subscriber is genuinely still billed in MXN, and a founding
  // subscriber's price is locked below today's; re-deriving either from the
  // plan table would quietly misquote what she actually pays.
  const price =
    subscription.lockedPriceMinorUnits != null
      ? formatMinorUnits(subscription.lockedPriceMinorUnits, subscription.currency)
      : null;
  const interval = PLAN_INTERVAL[entitlements.plan];

  // A trial grants the full Pro feature set, but the row's `plan` is still
  // `free` — that is what she FALLS BACK to, not what she has. Labelling the
  // card "Free" while the line under it counts down a Pro trial was the page
  // contradicting itself in two adjacent elements.
  const planName = entitlements.isTrialing
    ? t("web.settings.billing.trialPlanName")
    : planLabel(entitlements.plan, locale);

  // headline / detail / icon, chosen once so the JSX below stays flat.
  const { Icon, headline, detail } = describe(summary, {
    t,
    date,
    comped: entitlements.comped,
  });
  // needsAttention overrides the disposition's default tone, which is what
  // makes a past_due row with no date to quote still read as urgent.
  const tone: Tone = entitlements.comped
    ? "neutral"
    : summary.disposition === "none" && summary.needsAttention
      ? "danger"
      : TONE[summary.disposition];

  // Cancelled-but-live is the one state where the portal's job is to UNDO
  // something, so the button says so. Everywhere else it is the general
  // "change card, get receipts, cancel" door.
  const portalLabel =
    summary.disposition === "ends"
      ? t("web.settings.billing.resumeSubscription")
      : summary.disposition === "grace_ends"
        ? t("web.settings.billing.updateCard")
        : t("web.settings.billing.manageBilling");

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <Text size="small" tone="muted" as="p" className="font-medium">
              {t("web.settings.billing.summaryLabel")}
            </Text>
            <Heading level={2} as="h2" className="mt-0.5">
              {planName}
            </Heading>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {entitlements.comped && (
              <Badge variant="success">{t("web.settings.billing.compedBadge")}</Badge>
            )}
            {entitlements.plan === "founding" && (
              <Badge variant="warning">{t("web.settings.billing.foundingBadge")}</Badge>
            )}
          </div>
        </div>

        {/* Price. `tabular-nums` so the figure reads as money rather than as
            prose, and the interval is a separate muted word rather than a
            glued "/yr" — at this size the slash reads as part of the number. */}
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-display text-h2 font-semibold tabular-nums">
            {price ?? t("web.settings.billing.freePrice")}
          </span>
          {price && interval !== "none" && (
            <span className="text-sm text-muted-foreground">
              {interval === "year"
                ? t("web.settings.billing.interval.annual")
                : t("web.settings.billing.interval.monthly")}
            </span>
          )}
        </p>

        {/* The disposition. Icon + tinted ground + words — three signals, so
            the state survives both a monochrome render and a screen reader. */}
        <div className={`flex items-start gap-3 rounded-md p-3 ${TONE_CLASS[tone]}`}>
          <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {/* Hierarchy here is WEIGHT, not opacity. `text-warning` on
              `bg-warning-bg` is a pair the palette contrast test verifies;
              dropping the second line to 90% makes it a colour no token names,
              which is precisely the defect that put the Badge variants on
              solid grounds in the first place. */}
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-semibold">{headline}</p>
            <p className="text-sm">{detail}</p>
          </div>
        </div>
      </CardContent>

      {(hasPortal || plansHref) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-6 py-4">
          {plansHref && (
            <Button asChild>
              <a href={plansHref}>{t("web.settings.billing.seePlans")}</a>
            </Button>
          )}
          {hasPortal && (
            <>
              <form action={openBillingPortal}>
                <Button type="submit" variant="outline">
                  {portalLabel}
                </Button>
              </form>
              <p className="min-w-48 flex-1 text-xs text-muted-foreground">
                {t("web.settings.billing.portalHint")}
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function describe(
  summary: BillingSummary,
  ctx: { t: TFunction; date: string; comped: boolean },
): { Icon: typeof CalendarClock; headline: string; detail: string } {
  const { t, date, comped } = ctx;
  switch (summary.disposition) {
    case "renews":
      return {
        Icon: CalendarClock,
        headline: t("web.settings.billing.renews", { date }),
        detail: t("web.settings.billing.renewsDetail"),
      };
    case "ends":
      return {
        Icon: CalendarX,
        headline: t("web.settings.billing.ends", { date }),
        detail: t("web.settings.billing.endsDetail"),
      };
    case "trial_ends":
      return {
        Icon: CalendarClock,
        // `count` drives the CLDR plural variant — the catalog carries a
        // `_one` form rather than the "{days} day(s)" this page used to print.
        headline: t("web.settings.billing.trialDaysLeft", { count: summary.daysRemaining ?? 0 }),
        detail: t("web.settings.billing.trialDetail", { date }),
      };
    case "grace_ends":
      return {
        Icon: AlertTriangle,
        headline: t("web.settings.billing.paymentFailed"),
        detail: t("web.settings.billing.paymentFailedDetail", { date }),
      };
    case "none":
      // Three unrelated rows land on "nothing scheduled" and they are NOT the
      // same message: a comped account, a failed payment we have no date to
      // quote for, and plain Free. Collapsing them was how the last version
      // reassured a past_due teacher that her plan does not expire.
      if (comped) {
        return {
          Icon: Gift,
          headline: t("web.settings.billing.compedBadge"),
          detail: t("web.settings.billing.compedDetail"),
        };
      }
      if (summary.needsAttention) {
        return {
          Icon: AlertTriangle,
          headline: t("web.settings.billing.paymentFailed"),
          detail: t("web.settings.billing.paymentFailedNoDate"),
        };
      }
      return {
        Icon: InfinityIcon,
        headline: t("web.settings.billing.freeHeadline"),
        detail: t("web.settings.billing.freeDetail"),
      };
  }
}
