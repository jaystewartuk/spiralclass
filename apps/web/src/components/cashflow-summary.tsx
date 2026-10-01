import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { intlLocale } from "@spiralclass/shared";
import { formatMinorUnits } from "@/lib/money";
import { capitalizeFirst } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import type { CashFlow, CashFlowSummary, MonthEarnings } from "@/lib/cashflow";

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
        sub={classesTaught(summary.currentMonthLessons, t)}
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
/**
 * "September", from a `YYYY-MM` key — or "September 2025" when the year has to
 * be said. Formatted from MIDDAY UTC on the 1st, in UTC: the key is already a
 * month on her calendar, and formatting a real midnight in a zone behind UTC
 * would name the month before (see `LedgerMonth.date` in payments-list.ts).
 */
function monthName(key: string, locale: string, withYear: boolean): string {
  const [year, month] = key.split("-").map(Number);
  const label = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: "UTC",
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(Date.UTC(year, month - 1, 1, 12)));
  // ICU lower-cases month names in Spanish and French, and a label should not.
  return capitalizeFirst(label, locale);
}

function classesTaught(count: number, t: TFunction): string {
  return t(count === 1 ? "web.cashflow.classesTaughtOne" : "web.cashflow.classesTaught", {
    count,
  });
}

/**
 * What each month of teaching earned, newest first, for the Payments page.
 *
 * Exists because "this month" resets to nothing on the 1st, and a teacher who
 * used to close each month in a notebook had nowhere to read what the month
 * she just finished came to — let alone compare it with the one before. Every
 * month from her first class (up to a year back) is listed, a month she taught
 * nothing in as a zero, because a gap would hide the very month worth seeing.
 *
 * The figures are the same basis as "this month" — classes taught, filed by the
 * month on HER calendar — so the September row here is exactly what "this
 * month" read on the 30th. The bar is a relative-size cue only and carries no
 * information the number beside it does not, so it is hidden from assistive
 * technology.
 */
export async function EarningsByMonth({ cashFlow }: { cashFlow: CashFlow }) {
  const [t, locale] = await Promise.all([getT(), getPreferredLocale()]);
  const slices = cashFlow.byCurrency.filter((s) => s.months.length > 0);
  if (slices.length === 0) return null;
  const perCurrency = slices.length > 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="scroll-mt-24 text-lg" as="h2" id="earned-by-month">
          {t("web.cashflow.byMonth.title")}
        </CardTitle>
        <CardDescription>{t("web.cashflow.byMonth.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {slices.map((summary) => (
          <div key={summary.currency} className="space-y-2">
            {perCurrency && (
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("web.cashflow.inCurrency", { currency: summary.currency })}
              </h3>
            )}
            <MonthList months={summary.months} currency={summary.currency} locale={locale} t={t} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function MonthList({
  months,
  currency,
  locale,
  t,
}: {
  months: MonthEarnings[];
  currency: string;
  locale: string;
  t: TFunction;
}) {
  const best = Math.max(...months.map((m) => m.earnedCents));
  // The year is said only where it is not obvious: on every row once the list
  // reaches back past January, so "December" is never left to be guessed.
  const spansYears = months[0].month.slice(0, 4) !== months[months.length - 1].month.slice(0, 4);
  return (
    <ol className="divide-y divide-border">
      {months.map((m, index) => (
        <li key={m.month} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <span className="font-medium">{monthName(m.month, locale, spansYears)}</span>
              {index === 0 && (
                <span className="text-sm text-muted-foreground">
                  {" "}
                  · {t("web.cashflow.byMonth.soFar")}
                </span>
              )}
              <div className="text-sm text-muted-foreground">{classesTaught(m.lessons, t)}</div>
            </div>
            <div className="font-semibold tabular-nums">
              {formatMinorUnits(m.earnedCents, currency)}
            </div>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className="h-full rounded-full bg-success"
              style={{ width: best > 0 ? `${(m.earnedCents / best) * 100}%` : 0 }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

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
  const [t, locale] = await Promise.all([getT(), getPreferredLocale()]);
  const summary = cashFlow.primary;
  // The month she just closed, named — on the 1st "this month" is nothing yet,
  // and this is the figure she opened the screen for. Shown once she has
  // taught for longer than the current month, so a teacher in her first month
  // is not shown an empty "August" she was never here for.
  const previous = summary.months[1];
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
        {/* Each month's class count sits under that month's label. As a
            free-standing line below the list it read as a footnote to
            whichever row happened to be last — "Held", once the closed month
            joined the list. */}
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">
              {t("web.cashflow.thisMonth")}
              <span className="block text-xs">{classesTaught(summary.currentMonthLessons, t)}</span>
            </dt>
            <dd className="font-medium tabular-nums">
              {formatMinorUnits(summary.currentMonthEarnedCents, summary.currency)}
            </dd>
          </div>
          {previous && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">
                {monthName(previous.month, locale, false)}
                <span className="block text-xs">{classesTaught(previous.lessons, t)}</span>
              </dt>
              <dd className="font-medium tabular-nums">
                {formatMinorUnits(previous.earnedCents, summary.currency)}
              </dd>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{t("web.cashflow.held")}</dt>
            <dd className="font-medium text-warning tabular-nums">
              {formatMinorUnits(summary.heldCents, summary.currency)}
            </dd>
          </div>
        </dl>
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
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Link
            href="/payments"
            className="inline-block text-sm font-medium underline underline-offset-4"
          >
            {t("web.cashflow.seeEarnedVsHeld")}
          </Link>
          {previous && (
            <Link
              href="/payments#earned-by-month"
              className="inline-block text-sm font-medium underline underline-offset-4"
            >
              {t("web.cashflow.seeByMonth")}
            </Link>
          )}
        </div>
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
