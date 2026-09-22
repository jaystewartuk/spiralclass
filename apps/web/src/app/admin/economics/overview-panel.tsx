"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CategoryBarChart, CHART_CATEGORY_COLORS } from "@/components/ui/chart";
import { formatGbp } from "@/lib/money";
import {
  toBarSeries,
  INTEGRATION_CATEGORIES,
  type IntegrationCategory,
  type ChartDatum,
} from "@spiralclass/shared";
import { useT } from "@/components/locale-provider";
import type { EconomicsOverview } from "@/lib/economics/estimate";
import type { EconomicsAssumptionsValues } from "@/lib/economics/assumptions";
import { AssumptionsForm } from "./assumptions-form";

// Only the validated 4-color categorical set exists (dataviz skill) — same
// posture as admin/costs/page.tsx's CATEGORY_COLORS: categories beyond the
// first 4 (declaration order) share the muted "other" tone instead of an
// unvalidated 5th+ hue.
function categoryColors(): Record<IntegrationCategory, string> {
  const colors = {} as Record<IntegrationCategory, string>;
  INTEGRATION_CATEGORIES.forEach((category, i) => {
    colors[category] =
      i < CHART_CATEGORY_COLORS.length ? CHART_CATEGORY_COLORS[i] : "hsl(var(--muted-foreground))";
  });
  return colors;
}

function pct(fraction: number | null): string {
  if (fraction === null) return "—";
  return `${(fraction * 100).toFixed(1)}%`;
}

export function OverviewPanel({
  overview,
  assumptions,
}: {
  overview: EconomicsOverview;
  assumptions: EconomicsAssumptionsValues;
}) {
  const t = useT();

  const categoryLabels: Record<IntegrationCategory, string> = Object.fromEntries(
    INTEGRATION_CATEGORIES.map((c) => [c, t(`economics.category.${c}`)]),
  ) as Record<IntegrationCategory, string>;

  const categoryChart: ChartDatum[] = toBarSeries(
    overview.byCategory,
    INTEGRATION_CATEGORIES,
    categoryLabels,
    categoryColors(),
  );

  return (
    <div className="space-y-6">
      {overview.unresolvedIntegrationKeys.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {t("web.admin.economics.overview.unresolvedWarning", {
              count: overview.unresolvedIntegrationKeys.length,
            })}{" "}
            {overview.unresolvedIntegrationKeys.join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("web.admin.economics.overview.kpiCost")}
          value={formatGbp(overview.totalCostPence)}
        />
        <StatCard
          label={t("web.admin.economics.overview.kpiRevenue")}
          value={formatGbp(overview.estMonthlyRevenuePence)}
        />
        <StatCard
          label={t("web.admin.economics.overview.kpiProfit")}
          value={formatGbp(overview.grossProfitPence)}
          danger={overview.grossProfitPence < 0}
        />
        <StatCard
          label={t("web.admin.economics.overview.kpiMargin")}
          value={pct(overview.grossMarginFraction)}
          danger={(overview.grossMarginFraction ?? 0) < 0}
        />
        <StatCard
          label={t("web.admin.economics.overview.kpiCostPerTeacher")}
          value={
            overview.costPerActiveTeacherPence === null
              ? t("web.admin.economics.overview.noData")
              : formatGbp(overview.costPerActiveTeacherPence)
          }
        />
        <StatCard
          label={t("web.admin.economics.overview.kpiCostPerLesson")}
          value={
            overview.costPerLessonPence === null
              ? t("web.admin.economics.overview.noData")
              : formatGbp(overview.costPerLessonPence)
          }
        />
        <StatCard
          label={t("web.admin.economics.overview.highestIntegration")}
          value={overview.highestCostIntegration?.name ?? t("web.admin.economics.overview.noData")}
          hint={
            overview.highestCostIntegration
              ? formatGbp(overview.highestCostIntegration.gbpPence)
              : undefined
          }
        />
        <StatCard
          label={t("web.admin.economics.overview.highestCategory")}
          value={
            overview.highestCostCategory
              ? categoryLabels[overview.highestCostCategory.category]
              : t("web.admin.economics.overview.noData")
          }
          hint={
            overview.highestCostCategory
              ? formatGbp(overview.highestCostCategory.gbpPence)
              : undefined
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {t("web.admin.economics.overview.byCategoryTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryBarChart data={categoryChart} valueFormat="gbp" />
        </CardContent>
      </Card>

      <AssumptionsForm initial={assumptions} />
    </div>
  );
}
