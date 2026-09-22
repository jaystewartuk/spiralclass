import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMinorUnits } from "@/lib/money";
import { getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import type { CashFlow, CashFlowSummary } from "@/lib/cashflow";

// Both renderers below take the whole `CashFlow` rather than one summary,
// because cash flow is per currency: a teacher who changed her pricing currency
// with paid packages on file has money in two, and the old rows keep the
// currency they were sold in. **One currency is the case to optimize for** —
// it is every teacher today — so a single-currency teacher sees exactly what
// she saw before, with no heading, no grouping and no currency picker. The
// second currency is what makes anything fan out.

// Full breakdown for the Payments page: the hero "safe to spend" figure plus
// the earned/held split and a one-line explainer of what they mean.
export async function CashFlowPanel({ cashFlow }: { cashFlow: CashFlow }) {
  const t = await getT();
  const perCurrency = cashFlow.byCurrency.length > 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg" as="h2">
          {t("web.cashflow.title")}
        </CardTitle>
        <CardDescription>{t("web.cashflow.explainer")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {cashFlow.byCurrency.map((summary) => (
          <div key={summary.currency} className="space-y-2">
            {perCurrency && (
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("web.cashflow.inCurrency", { currency: summary.currency })}
              </h3>
            )}
            <CashFlowStats summary={summary} t={t} />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{t("web.cashflow.whyAverage")}</p>
      </CardContent>
    </Card>
  );
}

// The four figures for ONE currency. Two columns before four: the old
// `lg:grid-cols-4` jumped straight from one column to four, so every tablet
// width rendered four figures in a single tall stack.
function CashFlowStats({ summary, t }: { summary: CashFlowSummary; t: TFunction }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label={t("web.cashflow.thisMonth")}
        value={formatMinorUnits(summary.currentMonthEarnedCents, summary.currency)}
        sub={t(
          summary.currentMonthLessons === 1
            ? "web.cashflow.classesTaughtOne"
            : "web.cashflow.classesTaught",
          { count: summary.currentMonthLessons },
        )}
      />
      <Stat
        label={t("web.cashflow.safeToSpendMonthly")}
        value={formatMinorUnits(summary.safeMonthlySpendCents, summary.currency)}
        sub={provisionalNote(summary.provisionalMonths, t)}
        hero
      />
      <Stat
        label={t("web.cashflow.earned")}
        value={formatMinorUnits(summary.earnedCents, summary.currency)}
        tone="success"
      />
      <Stat
        label={t("web.cashflow.held")}
        value={formatMinorUnits(summary.heldCents, summary.currency)}
        sub={
          summary.heldLessons > 0
            ? t(
                summary.heldLessons === 1
                  ? "web.cashflow.classesNotYetTaughtOne"
                  : "web.cashflow.classesNotYetTaught",
                { count: summary.heldLessons },
              )
            : undefined
        }
        tone="warning"
      />
    </div>
  );
}

// Explains *why* the figure is provisional while warming up — that it's
// averaged over only the few months of classes on record so far, and will
// settle as more history builds. Nothing once steady.
function provisionalNote(provisionalMonths: number, t: TFunction): string | undefined {
  if (provisionalMonths <= 0) return undefined;
  return t(provisionalMonths === 1 ? "web.cashflow.provisionalOne" : "web.cashflow.provisional", {
    count: provisionalMonths,
  });
}

/**
 * Compact daily-driver tile for the teacher dashboard's aside. Links through to
 * the full breakdown on the Payments page.
 *
 * The figure is the point, so it gets the page's largest type and nothing
 * competes with it: the label above is small and muted, and every qualifier
 * (provisional, this month so far, held) sits below in one quiet stack rather
 * than as three separately-styled lines. The old version put four lines at
 * roughly equal weight around a 30px number sitting alone in a 1,232px-wide
 * card, which read as a caption with a number in it rather than as the answer
 * to "how am I doing?".
 *
 * The hero is the PRIMARY currency — the one she prices in today, which is what
 * "safe to spend" is a claim about. A retired currency, if she has one, gets a
 * quiet line at the bottom rather than a second hero; the full split is on the
 * Payments page.
 *
 * `tabular-nums` throughout, because these figures are compared against
 * themselves across visits.
 */
export async function SafeToSpendTile({ cashFlow }: { cashFlow: CashFlow }) {
  const t = await getT();
  const summary = cashFlow.primary;
  const others = cashFlow.byCurrency.filter((s) => s.currency !== summary.currency);
  return (
    <Card>
      <CardHeader className="gap-1 pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground" as="h2">
          {t("web.cashflow.safeToSpendMonthly")}
        </CardTitle>
        <p className="text-h1 font-semibold tabular-nums">
          {formatMinorUnits(summary.safeMonthlySpendCents, summary.currency)}
        </p>
        <CardDescription>{t("web.cashflow.safeToSpendHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <dl className="space-y-1 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{t("web.cashflow.thisMonth")}</dt>
            <dd className="font-medium tabular-nums">
              {formatMinorUnits(summary.currentMonthEarnedCents, summary.currency)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{t("web.cashflow.held")}</dt>
            <dd className="font-medium text-warning tabular-nums">
              {formatMinorUnits(summary.heldCents, summary.currency)}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">
          {t(
            summary.currentMonthLessons === 1
              ? "web.cashflow.classesTaughtOne"
              : "web.cashflow.classesTaught",
            { count: summary.currentMonthLessons },
          )}
        </p>
        {summary.provisionalMonths > 0 && (
          <p className="text-sm text-muted-foreground">
            {provisionalNote(summary.provisionalMonths, t)}
          </p>
        )}
        {others.length > 0 && (
          <div className="space-y-1 border-t pt-2">
            <p className="text-sm text-muted-foreground">{t("web.cashflow.otherCurrencies")}</p>
            <dl className="space-y-1 text-sm">
              {others.map((other) => (
                <div key={other.currency} className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">
                    {t("web.cashflow.inCurrency", { currency: other.currency })}
                  </dt>
                  <dd className="font-medium tabular-nums">
                    {formatMinorUnits(other.safeMonthlySpendCents, other.currency)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {/* Underlined rather than `text-primary`: that token is verified only
            as a button FILL and measures 3.48:1 as text on a raised card in
            dark mode. See the note in dashboard-view.tsx. */}
        <Link
          href="/payments"
          className="inline-block text-sm font-medium underline underline-offset-4"
        >
          {t("web.cashflow.seeEarnedVsHeld")}
        </Link>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  sub,
  hero,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  hero?: boolean;
  tone?: "success" | "warning";
}) {
  const valueTone = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "";
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`font-semibold tabular-nums ${hero ? "font-display text-2xl" : "text-lg"} ${valueTone}`}
      >
        {value}
      </div>
      {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
