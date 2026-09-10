import { requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatMinorUnits } from "@/lib/money";
import { getT } from "@/lib/i18n";
import {
  getSubscriptionOverview,
  getCommissionReport,
  getWiseRenewalsDue,
} from "@/lib/subscriptions/admin-metrics";
import { COMMISSION_WINDOW_MONTHS } from "@/lib/subscriptions/config";
import { commissionRate } from "@/lib/subscriptions/commission";
import type { SubscriptionPlan, SubscriptionStatus } from "@/lib/subscriptions/config";
import { CategoryBarChart, CHART_CATEGORY_COLORS } from "@/components/ui/chart";
import { toBarSeries, PLATFORM_MONEY_CURRENCY } from "@spiralclass/shared";
import { WiseRenewalForm } from "./wise-renewal-form";

// Plan identity is true categorical data (no inherent order carries meaning),
// so each plan gets its own fixed slot from the validated chart palette.
const PLAN_ORDER: SubscriptionPlan[] = ["free", "monthly", "annual", "founding"];
const PLAN_COLORS: Record<SubscriptionPlan, string> = {
  free: CHART_CATEGORY_COLORS[0],
  monthly: CHART_CATEGORY_COLORS[1],
  annual: CHART_CATEGORY_COLORS[2],
  founding: CHART_CATEGORY_COLORS[3],
};

// Subscription status is state, not identity — reuse the reserved
// status/badge tokens (never a plain "series N" fill) so a status color never
// impersonates a plan-chart category.
const STATUS_ORDER: SubscriptionStatus[] = ["trialing", "active", "past_due", "canceled", "free"];
const STATUS_COLORS: Record<SubscriptionStatus, string> = {
  trialing: "hsl(var(--info))",
  active: "hsl(var(--success))",
  past_due: "hsl(var(--destructive))",
  canceled: "hsl(var(--muted-foreground))",
  free: "hsl(var(--accent))",
};

// Admin subscription / MRR overview + founding cohort + ambassador commission
// report. Finance role. CSV export at /api/admin/export/commission.
export default async function AdminSubscriptionsPage() {
  await requireAdmin("finance");
  const t = await getT();
  const PLAN_LABELS: Record<SubscriptionPlan, string> = {
    free: t("web.admin.plan.free"),
    monthly: t("web.admin.plan.monthly"),
    annual: t("web.admin.plan.annual"),
    founding: t("web.admin.plan.founding"),
  };
  const STATUS_LABELS: Record<SubscriptionStatus, string> = {
    trialing: t("web.admin.subscriptions.status.trialing"),
    active: t("web.admin.subscriptions.status.active"),
    past_due: t("web.admin.subscriptions.status.pastDue"),
    canceled: t("web.admin.subscriptions.status.canceled"),
    free: t("web.admin.subscriptions.status.free"),
  };
  const [overview, commission, wiseRenewalsDue] = await Promise.all([
    getSubscriptionOverview(),
    getCommissionReport(),
    getWiseRenewalsDue(),
  ]);

  const monthlyTotal = commission.reduce((sum, a) => sum + a.totalPayableMinorUnits, 0);
  const planChartData = toBarSeries(overview.byPlan, PLAN_ORDER, PLAN_LABELS, PLAN_COLORS);
  const statusChartData = toBarSeries(
    overview.byStatus,
    STATUS_ORDER,
    STATUS_LABELS,
    STATUS_COLORS,
  );
  const otherCurrencyMrrEntries = Object.entries(overview.mrrOtherCurrencyMinorUnits);

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.subscriptions.title")} />
        <p className="text-muted-foreground text-sm">{t("web.admin.subscriptions.subtitle")}</p>
      </header>

      {otherCurrencyMrrEntries.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {t("web.admin.subscriptions.otherCurrencyMrrNote")}{" "}
            {otherCurrencyMrrEntries
              .map(([currency, cents]) => formatMinorUnits(cents, currency))
              .join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={t("web.admin.money.mrr")}
          value={formatMinorUnits(overview.mrrMinorUnits, PLATFORM_MONEY_CURRENCY)}
          hint={t("web.admin.subscriptions.mrrHint")}
        />
        <Stat
          label={t("web.admin.money.paid")}
          value={overview.paidCount}
          hint={t("web.admin.subscriptions.compedHint", { count: overview.compedCount })}
        />
        <Stat label={t("web.admin.subscriptions.free")} value={overview.freeCount} />
        <Stat
          label={t("web.admin.money.trialing")}
          value={overview.trialingCount}
          hint={t("web.admin.subscriptions.endingSoonHint", { count: overview.trialsEndingSoon })}
        />
        <Stat
          label={t("web.admin.money.pastDue")}
          value={overview.pastDueCount}
          danger={overview.pastDueCount > 0}
        />
        <Stat label={t("web.admin.subscriptions.monthlyPlan")} value={overview.byPlan.monthly} />
        <Stat label={t("web.admin.subscriptions.annualPlan")} value={overview.byPlan.annual} />
        <Stat label={t("web.admin.subscriptions.foundingPlan")} value={overview.byPlan.founding} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.subscriptions.byPlan")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryBarChart data={planChartData} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.subscriptions.byStatus")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryBarChart data={statusChartData} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.subscriptions.foundingCohort")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p>
            {t("web.admin.subscriptions.foundingCount", {
              headcount: overview.founding.headcount,
              cap: overview.founding.cap,
            })}{" "}
            ·{" "}
            {t("web.admin.subscriptions.foundingCutoff", {
              date: overview.founding.cutoffAt.toISOString().slice(0, 10),
            })}{" "}
            ·{" "}
            <span className={overview.founding.isOpen ? "text-success" : "text-muted-foreground"}>
              {overview.founding.isOpen
                ? t("web.admin.subscriptions.open")
                : t("web.admin.subscriptions.closed")}
            </span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.subscriptions.wiseRenewalsDue")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p className="text-muted-foreground mb-3">
            {t("web.admin.subscriptions.wiseRenewalsBody")}
          </p>
          {wiseRenewalsDue.length === 0 ? (
            <p className="text-muted-foreground">{t("web.admin.subscriptions.nothingDue")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground text-left">
                <tr>
                  <th className="py-1">{t("web.admin.subscriptions.colTeacher")}</th>
                  <th>{t("web.admin.subscriptions.colPlan")}</th>
                  <th>{t("web.admin.subscriptions.colPeriodEnds")}</th>
                  <th>{t("web.admin.subscriptions.colAmount")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {wiseRenewalsDue.map((r) => (
                  <tr key={r.teacherId} className="border-t">
                    <td className="py-2">
                      <div className="font-medium">{r.teacherName}</div>
                      <div className="text-muted-foreground">{r.teacherEmail}</div>
                    </td>
                    <td>{r.plan}</td>
                    <td className={r.overdue ? "text-destructive" : undefined}>
                      {r.currentPeriodEnd.toISOString().slice(0, 10)}
                      {r.overdue ? ` ${t("web.admin.subscriptions.overdue")}` : ""}
                    </td>
                    <td>
                      {r.lockedPriceMinorUnits != null
                        ? formatMinorUnits(r.lockedPriceMinorUnits)
                        : "—"}
                    </td>
                    <td>
                      <WiseRenewalForm
                        teacherId={r.teacherId}
                        plan={r.plan}
                        lockedPriceMinorUnits={r.lockedPriceMinorUnits}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">
            {t("web.admin.subscriptions.ambassadorCommission")}
          </CardTitle>
          <Button asChild variant="outline" size="sm">
            <Link href="/api/admin/export/commission">
              {t("web.admin.subscriptions.exportCsv")}
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {t("web.admin.subscriptions.commissionBody", {
              rate: Math.round(commissionRate() * 100),
              months: COMMISSION_WINDOW_MONTHS,
            })}
          </p>
          {commission.length === 0 ? (
            <p className="text-muted-foreground">{t("web.admin.subscriptions.noReferred")}</p>
          ) : (
            <div className="space-y-4">
              {commission.map((a) => (
                <div key={a.ambassador} className="rounded-md border p-3">
                  <div className="flex items-center justify-between font-medium">
                    <span>{a.ambassador}</span>
                    <span>{formatMinorUnits(a.totalPayableMinorUnits)}</span>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {t("web.admin.subscriptions.commissionSummary", {
                      referred: a.referredTeacherCount,
                      invoices: a.lineItems.length,
                      net: formatMinorUnits(a.totalNetMinorUnits),
                    })}
                  </div>
                  {a.lineItems.length > 0 && (
                    <table className="mt-2 w-full text-xs">
                      <thead className="text-muted-foreground text-left">
                        <tr>
                          <th className="py-1">{t("web.admin.subscriptions.colTeacher")}</th>
                          <th>{t("web.admin.subscriptions.colPeriod")}</th>
                          <th className="text-right">{t("web.admin.subscriptions.colNet")}</th>
                          <th className="text-right">{t("web.admin.subscriptions.colPayable")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.lineItems.map((li) => (
                          <tr key={li.invoiceId} className="border-t">
                            <td className="py-1">{li.teacherName}</td>
                            <td>{li.periodStart.toISOString().slice(0, 10)}</td>
                            <td className="text-right">{formatMinorUnits(li.netMinorUnits)}</td>
                            <td className="text-right">{formatMinorUnits(li.payableMinorUnits)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-between border-t pt-2 font-semibold">
                <span>{t("web.admin.subscriptions.monthlyTotalPayable")}</span>
                <span>{formatMinorUnits(monthlyTotal)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: number | string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className={`mt-1 text-2xl font-semibold ${danger ? "text-destructive" : ""}`}>
          {value}
        </div>
        {hint ? <div className="text-muted-foreground mt-1 text-xs">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
