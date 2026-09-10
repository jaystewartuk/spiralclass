import { getT } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/page-header";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatMinorUnits } from "@/lib/money";
import { CategoryBarChart, CHART_CATEGORY_COLORS, CHART_SERIES_COLOR } from "@/components/ui/chart";
import {
  toBarSeries,
  type ChartDatum,
  EXPENSE_CATEGORIES,
  type ExpenseCategory,
  PLATFORM_MONEY_CURRENCY,
} from "@spiralclass/shared";
import {
  getSubscriptionRevenueSeries,
  getPlatformExpenseSeries,
  summarizeNetProfitSeries,
  monthLabel,
} from "@/lib/money-metrics";
import { CostsTable, type ExpenseRow } from "./costs-table";

const WINDOW_MONTHS = 6;

// Only the validated 4-color categorical set exists (dataviz skill); the
// three remaining categories share the muted "other" tone rather than
// stretching to an unvalidated 5th/6th/7th hue.
const CATEGORY_COLORS: Record<ExpenseCategory, string> = {
  hosting: CHART_CATEGORY_COLORS[0],
  ai: CHART_CATEGORY_COLORS[1],
  dev_tools: CHART_CATEGORY_COLORS[2],
  monitoring: CHART_CATEGORY_COLORS[3],
  email: "hsl(var(--muted-foreground))",
  domain: "hsl(var(--muted-foreground))",
  other: "hsl(var(--muted-foreground))",
};

// The costs side of the owner's P&L, structured from docs/deployment/COST_PLAYBOOK.md
// — manually entered platform running costs, netted against admin/money's
// subscription revenue + commission into a net-profit view. Finance role,
// same as admin/money.
export default async function AdminCostsPage() {
  await requireAdmin("finance");
  const t = await getT();

  const CATEGORY_LABELS: Record<ExpenseCategory, string> = Object.fromEntries(
    EXPENSE_CATEGORIES.map((c) => [c, t(`expense.category.${c}`)]),
  ) as Record<ExpenseCategory, string>;

  const [revenue, expenses, rows] = await Promise.all([
    getSubscriptionRevenueSeries(WINDOW_MONTHS),
    getPlatformExpenseSeries(WINDOW_MONTHS),
    prisma.platformExpense.findMany({
      orderBy: [{ periodMonth: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  const netProfitSeries = summarizeNetProfitSeries(revenue.series, expenses.series);

  const currentExpense = expenses.series.at(-1)!;
  const currentNetProfit = netProfitSeries.at(-1)!;
  const expenseWindowTotal = expenses.series.reduce((s, p) => s + p.totalMinorUnits, 0);
  const netProfitWindowTotal = netProfitSeries.reduce((s, p) => s + p.netProfitMinorUnits, 0);

  const expenseChart: ChartDatum[] = expenses.series.map((p) => ({
    key: p.month,
    label: monthLabel(p.month),
    value: p.totalMinorUnits,
    color: CHART_SERIES_COLOR,
  }));
  const netProfitChart: ChartDatum[] = netProfitSeries.map((p) => ({
    key: p.month,
    label: monthLabel(p.month),
    value: p.netProfitMinorUnits,
    color: CHART_SERIES_COLOR,
  }));

  const categoryTotals = expenses.series.reduce(
    (acc, point) => {
      for (const c of EXPENSE_CATEGORIES) acc[c] = (acc[c] ?? 0) + point.byCategory[c];
      return acc;
    },
    {} as Record<ExpenseCategory, number>,
  );
  const categoryChart = toBarSeries(
    categoryTotals,
    EXPENSE_CATEGORIES,
    CATEGORY_LABELS,
    CATEGORY_COLORS,
  );

  const entries: ExpenseRow[] = rows.map((r) => ({
    id: r.id,
    // `vendor` is app-validated against KNOWN_EXPENSE_VENDORS at write time
    // (createExpenseAction/updateExpenseAction) but stored as plain TEXT —
    // see the schema comment on PlatformExpense.
    vendor: r.vendor as ExpenseRow["vendor"],
    vendorLabel: r.vendorLabel,
    category: r.category,
    amountMinorUnits: r.amountMinorUnits,
    currency: r.currency,
    periodMonth: r.periodMonth.toISOString().slice(0, 7),
    notes: r.notes,
  }));

  const otherCurrencyEntries = [
    ...Object.entries(expenses.otherCurrencyTotals),
    ...Object.entries(revenue.otherCurrencyTotals),
  ];

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.costs.title")} />
        <p className="text-muted-foreground text-sm">{t("web.admin.costs.intro")}</p>
      </header>

      {otherCurrencyEntries.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {t("web.admin.costs.nonMxnNote")}{" "}
            {otherCurrencyEntries
              .map(([currency, cents]) => formatMinorUnits(cents, currency))
              .join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("web.admin.costs.thisMonth")}
          value={formatMinorUnits(currentExpense.totalMinorUnits, PLATFORM_MONEY_CURRENCY)}
          hint={t("web.admin.costs.thisMonthHint")}
        />
        <StatCard
          label={t("web.admin.costs.windowTotal", { months: WINDOW_MONTHS })}
          value={formatMinorUnits(expenseWindowTotal, PLATFORM_MONEY_CURRENCY)}
        />
        <StatCard
          label={t("web.admin.costs.netProfitThisMonth")}
          value={formatMinorUnits(currentNetProfit.netProfitMinorUnits, PLATFORM_MONEY_CURRENCY)}
          danger={currentNetProfit.netProfitMinorUnits < 0}
        />
        <StatCard
          label={t("web.admin.costs.netProfitWindow", { months: WINDOW_MONTHS })}
          value={formatMinorUnits(netProfitWindowTotal, PLATFORM_MONEY_CURRENCY)}
          danger={netProfitWindowTotal < 0}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.costs.expenseChartTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-3 text-sm">
              {t("web.admin.costs.expenseChartBody", { months: WINDOW_MONTHS })}
            </p>
            <CategoryBarChart data={expenseChart} valueFormat="minorUnits" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.costs.netProfitChartTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-3 text-sm">
              {t("web.admin.costs.netProfitChartBody")}
            </p>
            <CategoryBarChart data={netProfitChart} valueFormat="minorUnits" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {t("web.admin.costs.byCategoryTitle", { months: WINDOW_MONTHS })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryBarChart data={categoryChart} valueFormat="minorUnits" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.costs.entries")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CostsTable entries={entries} />
        </CardContent>
      </Card>
    </div>
  );
}
