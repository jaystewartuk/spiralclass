import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { getT } from "@/lib/i18n";
import { requireAdmin } from "@/lib/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StatCard } from "@/components/ui/stat";
import { HelpTip } from "@/components/help-tip";
import { formatMinorUnits } from "@/lib/money";
import { CategoryBarChart, CHART_CATEGORY_COLORS, CHART_SERIES_COLOR } from "@/components/ui/chart";
import { toBarSeries, type ChartDatum, PLATFORM_MONEY_CURRENCY } from "@spiralclass/shared";
import { getSubscriptionOverview } from "@/lib/subscriptions/admin-metrics";
import type { SubscriptionPlan } from "@/lib/subscriptions/config";
import {
  getSubscriptionRevenueSeries,
  getGmvSeries,
  computePlatformDeferredRevenue,
  monthLabel,
} from "@/lib/money-metrics";

const WINDOW_MONTHS = 6;

// Paid plans only — `free` never appears in a revenue-mix chart.
const PAID_PLAN_ORDER: SubscriptionPlan[] = ["monthly", "annual", "founding"];
const PLAN_COLORS: Record<SubscriptionPlan, string> = {
  free: CHART_CATEGORY_COLORS[0],
  monthly: CHART_CATEGORY_COLORS[1],
  annual: CHART_CATEGORY_COLORS[2],
  founding: CHART_CATEGORY_COLORS[3],
};

// The owner's money-of-record dashboard. Every number here comes straight from
// Postgres — the source of truth for money — not from event analytics, which
// is behavioral and never authoritative for revenue. Finance role.
export default async function AdminMoneyPage() {
  await requireAdmin("finance");
  const t = await getT();

  const PLAN_LABELS: Record<SubscriptionPlan, string> = {
    free: t("web.admin.plan.free"),
    monthly: t("web.admin.plan.monthly"),
    annual: t("web.admin.plan.annual"),
    founding: t("web.admin.plan.founding"),
  };

  const [overview, revenue, gmvSeries, deferred] = await Promise.all([
    getSubscriptionOverview(),
    getSubscriptionRevenueSeries(WINDOW_MONTHS),
    getGmvSeries(WINDOW_MONTHS),
    computePlatformDeferredRevenue(),
  ]);
  const revenueSeries = revenue.series;
  const otherCurrencyEntries = [
    ...Object.entries(overview.mrrOtherCurrencyMinorUnits),
    ...Object.entries(revenue.otherCurrencyTotals),
  ];

  // Headline "this month so far" figures = the last (current, partial) bucket.
  const currentRevenue = revenueSeries.at(-1)!;
  const currentGmv = gmvSeries.at(-1)!;
  const collectedWindowNet = revenueSeries.reduce((s, p) => s + p.netMinorUnits, 0);
  const gmvWindowTotal = gmvSeries.reduce((s, p) => s + p.totalMinorUnits, 0);

  // Time-series bars: one hue across months (magnitude, not competing
  // categories), value direct-labeled as money.
  const revenueChart: ChartDatum[] = revenueSeries.map((p) => ({
    key: p.month,
    label: monthLabel(p.month),
    value: p.netMinorUnits,
    color: CHART_SERIES_COLOR,
  }));
  const gmvChart: ChartDatum[] = gmvSeries.map((p) => ({
    key: p.month,
    label: monthLabel(p.month),
    value: p.totalMinorUnits,
    color: CHART_SERIES_COLOR,
  }));

  // GMV split by rail over the whole window — distinct categories, so distinct
  // colors. `unknown` = total minus the two named rails (legacy payments).
  const railCard = gmvSeries.reduce((s, p) => s + p.cardMinorUnits, 0);
  const railWise = gmvSeries.reduce((s, p) => s + p.wiseMinorUnits, 0);
  const railUnknown = gmvWindowTotal - railCard - railWise;
  const railChart: ChartDatum[] = toBarSeries(
    { card: railCard, wise: railWise, unknown: railUnknown },
    railUnknown > 0 ? (["card", "wise", "unknown"] as const) : (["card", "wise"] as const),
    {
      card: t("web.admin.money.railCard"),
      wise: t("web.admin.money.railWise"),
      unknown: t("web.admin.money.railUnknown"),
    },
    {
      card: CHART_CATEGORY_COLORS[0],
      wise: CHART_CATEGORY_COLORS[1],
      unknown: "hsl(var(--muted-foreground))",
    },
  );

  const planMix: ChartDatum[] = toBarSeries(
    overview.byPlan,
    PAID_PLAN_ORDER,
    PLAN_LABELS,
    PLAN_COLORS,
  );

  return (
    <div className="space-y-6">
      <header>
        <Heading level={2} as="h1" className="flex items-center gap-1.5">
          {t("web.admin.money.title")}
        </Heading>
        <p className="text-sm text-muted-foreground">
          {t("web.admin.money.intro.pre")}{" "}
          <strong>{t("web.admin.money.intro.subscriptions")}</strong>
          {t("web.admin.money.intro.post")}
        </p>
      </header>

      {otherCurrencyEntries.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {t("web.admin.subscriptions.otherCurrencyMrrNote")}{" "}
            {otherCurrencyEntries
              .map(([currency, cents]) => formatMinorUnits(cents, currency))
              .join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label={t("web.admin.money.mrr")}
          value={formatMinorUnits(overview.mrrMinorUnits, PLATFORM_MONEY_CURRENCY)}
          hint={t("web.admin.money.mrrHint")}
        />
        <StatCard
          label={t("web.admin.money.subRevenue")}
          value={formatMinorUnits(currentRevenue.netMinorUnits, PLATFORM_MONEY_CURRENCY)}
          hint={t("web.admin.money.subRevenueHint")}
        />
        <StatCard
          label={t("web.admin.money.gmv")}
          value={formatMinorUnits(currentGmv.totalMinorUnits)}
          hint={t("web.admin.money.gmvHint")}
        />
        {/* The biggest currency's liability, not every teacher's added
            together: minor units in two currencies do not sum to anything. The
            card below breaks out the rest. */}
        <StatCard
          label={t("web.admin.money.heldLiability")}
          value={formatMinorUnits(deferred.primary.heldCents, deferred.primary.currency)}
          hint={t("web.admin.money.heldLessons", { count: deferred.primary.heldLessons })}
          danger={deferred.primary.heldCents > 0}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.money.revenueChartTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              {t("web.admin.money.revenueChartBody", {
                months: WINDOW_MONTHS,
                amount: formatMinorUnits(collectedWindowNet, PLATFORM_MONEY_CURRENCY),
              })}
            </p>
            <CategoryBarChart data={revenueChart} valueFormat="minorUnits" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.money.gmvChartTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              {t("web.admin.money.gmvChartBody", {
                months: WINDOW_MONTHS,
                amount: formatMinorUnits(gmvWindowTotal),
              })}
            </p>
            <CategoryBarChart data={gmvChart} valueFormat="minorUnits" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {t("web.admin.money.gmvByRailTitle", { months: WINDOW_MONTHS })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryBarChart data={railChart} valueFormat="minorUnits" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">{t("web.admin.money.paidMixTitle")}</CardTitle>
            <Link
              href="/admin/subscriptions"
              className="text-xs text-muted-foreground underline underline-offset-2"
            >
              {t("web.admin.money.fullDetail")}
            </Link>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <span className="font-semibold">{overview.paidCount}</span>{" "}
                <span className="text-muted-foreground">{t("web.admin.money.paid")}</span>
              </span>
              <span>
                <span className="font-semibold">{overview.trialingCount}</span>{" "}
                <span className="text-muted-foreground">{t("web.admin.money.trialing")}</span>
              </span>
              <span>
                <span className="font-semibold">{overview.compedCount}</span>{" "}
                <span className="text-muted-foreground">{t("web.admin.money.comped")}</span>
              </span>
              <span className={overview.pastDueCount > 0 ? "text-destructive" : undefined}>
                <span className="font-semibold">{overview.pastDueCount}</span>{" "}
                {t("web.admin.money.pastDue")}
              </span>
            </div>
            <CategoryBarChart data={planMix} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.money.deferredTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">{t("web.admin.money.deferredBody")}</p>
            {/* One block per currency teachers have sold in. This roll-up is
                mixed-currency by construction — two teachers pricing
                differently is the ordinary case — and there is no FX rate here
                to collapse it with, so it is never collapsed. */}
            {deferred.byCurrency.map((slice) => (
              <div key={slice.currency} className="space-y-1">
                {deferred.byCurrency.length > 1 && (
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {t("web.cashflow.inCurrency", { currency: slice.currency })}
                  </h3>
                )}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <Line
                    label={t("web.admin.money.totalCollected")}
                    value={formatMinorUnits(slice.totalPaidCents, slice.currency)}
                  />
                  <Line
                    label={t("web.admin.money.earnedDelivered")}
                    value={formatMinorUnits(slice.earnedCents, slice.currency)}
                  />
                  <Line
                    label={t("web.admin.money.heldUndelivered")}
                    value={formatMinorUnits(slice.heldCents, slice.currency)}
                  />
                  <Line
                    label={t("web.admin.money.heldLessonsLabel")}
                    value={slice.heldLessons.toLocaleString()}
                  />
                </dl>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </>
  );
}
