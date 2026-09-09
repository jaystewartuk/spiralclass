import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import {
  confidenceLabel,
  conversionRate,
  formatMinorUnits,
  funnelSteps,
  observationText,
  type FunnelStepKey,
  type PerformanceRow,
} from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { acquisitionReport } from "@/lib/marketing/analytics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_SERIES_COLOR } from "@/components/ui/chart-tokens";
import { SectionNav } from "../section-nav";

// The acquisition results screen.
//
// It answers one question — what is actually getting this teacher students —
// so the columns are the funnel and nothing else. There are no impressions, no
// reach and no engagement rate: we cannot measure them honestly on platforms we
// do not post to, and a number that cannot be acted on is a number that costs
// attention for nothing.
//
// Every observation carries its confidence explicitly. "Pattern" means a
// comparison that cleared a sample-size and effect-size floor; below the floor
// the screen says so rather than ranking noise.
export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();
  const locale = await getPreferredLocale();
  const { window } = await searchParams;
  const windowDays = window === "30" ? 30 : 90;

  const report = await acquisitionReport({ teacherId: teacher.id, windowDays, locale });

  const rate = conversionRate(report.overall);
  const steps = funnelSteps(report.overall);
  const stepLabel: Record<FunnelStepKey, string> = {
    visits: t("web.getStudents.visits"),
    bookings: t("web.getStudents.startedCheckout"),
    students: t("web.getStudents.newStudents"),
  };
  const asPercent = (share: number) => `${(share * 100).toFixed(1)}%`;

  const renderRows = (rows: PerformanceRow[]) =>
    rows.length === 0 ? (
      <p className="text-sm text-muted-foreground">{t("web.getStudents.noResultsYet")}</p>
    ) : (
      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-0"
          >
            <span className="min-w-0 truncate font-medium">{row.label}</span>
            <span className="text-sm text-muted-foreground">
              {`${row.visits} ${t("web.getStudents.visits")} · ${row.enquiries} ${t(
                "web.getStudents.enquiries",
              )} · ${row.students} ${t("web.getStudents.newStudents")}`}
            </span>
          </div>
        ))}
      </div>
    );

  return (
    <PageShell width="default">
      <SectionNav current="results" />

      {/* The window is a property of what the page is showing, so it sits with
          the title rather than in a second control row above the navigation. */}
      <PageHeader
        title={t("web.getStudents.results")}
        actions={
          <>
            <Button asChild variant={windowDays === 30 ? "secondary" : "ghost"} size="sm">
              <Link
                href="/dashboard/get-students/results?window=30"
                aria-current={windowDays === 30 ? "true" : undefined}
              >
                {t("web.getStudents.last30")}
              </Link>
            </Button>
            <Button asChild variant={windowDays === 90 ? "secondary" : "ghost"} size="sm">
              <Link
                href="/dashboard/get-students/results?window=90"
                aria-current={windowDays === 90 ? "true" : undefined}
              >
                {t("web.getStudents.last90")}
              </Link>
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 py-6 text-center lg:grid-cols-4">
          <div>
            <div className="text-2xl font-semibold">{report.overall.visits}</div>
            <div className="text-xs text-muted-foreground">{t("web.getStudents.visits")}</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">{report.overall.enquiries}</div>
            <div className="text-xs text-muted-foreground">{t("web.getStudents.enquiries")}</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">{report.overall.students}</div>
            <div className="text-xs text-muted-foreground">{t("web.getStudents.newStudents")}</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">
              {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
            </div>
            <div className="text-xs text-muted-foreground">{t("web.getStudents.conversion")}</div>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{t("web.getStudents.realPeopleOnly")}</p>

      {/* The funnel, above the observations that interpret it. Three flat
          numbers cannot say WHERE a page loses people; this can, which is the
          difference between a scoreboard and a diagnosis. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.getStudents.whereTheyStop")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {steps.map((step, i) => (
            <div key={step.key}>
              {i > 0 && step.lostFromPrevious > 0 && (
                <p className="pb-2 text-xs text-muted-foreground">
                  {t("web.getStudents.stepLost", { count: step.lostFromPrevious })}
                </p>
              )}
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{stepLabel[step.key]}</span>
                <span className="text-sm tabular-nums">
                  {step.shareOfTop === null
                    ? String(step.count)
                    : `${step.count} · ${asPercent(step.shareOfTop)}`}
                </span>
              </div>
              {/* Two divs rather than the recharts CategoryBarChart: three
                  stages whose counts and percentages are already spelled out
                  beside them do not need axes, tooltips, a client chunk and a
                  220px skeleton. The COLOR still comes from the chart token —
                  --chart-1 is validated for contrast and CVD separation in both
                  themes, and --primary is the action colour for buttons, so
                  using it as a data fill would both dodge that validation and
                  blur "this is a control" into "this is data". chart-tokens is
                  the recharts-free module, imported exactly so a caller that
                  needs only a colour never pulls the chart chunk. */}
              <div className="mt-1 h-2 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-2 rounded"
                  style={{
                    width: `${Math.min(1, step.shareOfTop ?? 0) * 100}%`,
                    backgroundColor: CHART_SERIES_COLOR,
                  }}
                />
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t("web.getStudents.enquiriesAside")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.getStudents.whatWeSee")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {report.observations.map((o, i) => (
            <div key={`${o.code}-${i}`} className="flex flex-wrap items-start gap-2">
              <Badge variant={o.confidence === "pattern" ? "default" : "outline"}>
                {confidenceLabel(o.confidence, locale)}
              </Badge>
              <p className="min-w-0 flex-1 text-sm">{observationText(o, locale)}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.getStudents.byChannel")}</CardTitle>
        </CardHeader>
        <CardContent>{renderRows(report.channels)}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.getStudents.byCommunity")}</CardTitle>
        </CardHeader>
        <CardContent>{renderRows(report.communities)}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.getStudents.byContent")}</CardTitle>
        </CardHeader>
        <CardContent>{renderRows(report.content)}</CardContent>
      </Card>

      {report.overall.revenueMinorUnits > 0 && (
        <p className="text-sm text-muted-foreground">
          {`${t("web.getStudents.revenue")}: ${formatMinorUnits(
            report.overall.revenueMinorUnits,
            teacher.pricingCurrency,
          )}`}
        </p>
      )}
    </PageShell>
  );
}
