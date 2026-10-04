import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { intlLocale } from "@spiralclass/shared";
import { formatMinorUnits } from "@/lib/money";
import { capitalizeFirst } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import type { CashFlow, CashFlowSummary, MonthEarnings } from "@/lib/cashflow";

/*
 * The teacher's earnings, on the dashboard and the Payments page (D-191).
 *
 * WHAT THESE ANSWER, in the order a teacher asks:
 *
 *   1. How is this month going? — what she has earned teaching so far this
 *      month, plus what the rest of the month adds as booked.
 *   2. What did last month come to? — the closed figure, named ("September").
 *   3. How much of the money I have is not mine yet? — "paid in advance":
 *      classes students have paid for that she has still to teach.
 *   4. How do my months compare? — every month, opened by student; the year so
 *      far; a typical month and the lowest one, as facts.
 *
 * WHAT THEY NO LONGER SAY: "safe to spend each month". That was a 3-month
 * revenue average under a label banking apps use for "cash minus the bills you
 * have coming" — and we know neither her balance nor her bills. Teachers read
 * it as the name of the money box, not as an answer; the question they asked
 * was "how much did I close the month with", which it never showed. D-191 has
 * the research and the reasoning.
 *
 * Both surfaces take the whole `CashFlow`, because money is per currency. ONE
 * currency is the case to optimize for — every teacher today — so a
 * single-currency teacher sees no currency headings at all.
 */

/**
 * "September", from a `YYYY-MM` key — or "September 2025" when the year has to
 * be said. Formatted from MIDDAY UTC on the 1st, in UTC: the key is already a
 * month on her calendar, and formatting a real midnight in a zone behind UTC
 * would name the month before (see `LedgerMonth.date` in payments-list.ts).
 * Lower-case where the language writes it so ("octubre") — callers capitalise
 * when the name starts a label.
 */
function monthName(key: string, locale: string, withYear = false): string {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: "UTC",
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(Date.UTC(year, month - 1, 1, 12)));
}

const label = (text: string, locale: string) => capitalizeFirst(text, locale);

function classesTaught(count: number, t: TFunction): string {
  return t(count === 1 ? "web.cashflow.classesTaughtOne" : "web.cashflow.classesTaught", {
    count,
  });
}

/**
 * "38 classes still to teach · 6 already booked". The booked part is what makes
 * this agree with the students page, which counts only the classes left to
 * book — without it the two screens show different numbers with nothing to
 * say why.
 */
function classesToTeach(summary: CashFlowSummary, t: TFunction): string {
  const count = summary.heldLessons;
  const toTeach = t(count === 1 ? "web.cashflow.toTeachOne" : "web.cashflow.toTeach", { count });
  return summary.heldBookedLessons > 0
    ? t("web.cashflow.toTeachBooked", { toTeach, booked: summary.heldBookedLessons })
    : toTeach;
}

/** "+ $2,400 in 8 classes booked for the rest of October", or nothing. */
function bookedLine(summary: CashFlowSummary, locale: string, t: TFunction): string | null {
  if (summary.bookedRestOfMonthLessons === 0) return null;
  return t(
    summary.bookedRestOfMonthLessons === 1
      ? "web.cashflow.bookedRestOne"
      : "web.cashflow.bookedRest",
    {
      amount: formatMinorUnits(summary.bookedRestOfMonthCents, summary.currency, locale),
      count: summary.bookedRestOfMonthLessons,
      month: monthName(summary.currentMonth, locale),
    },
  );
}

/** The label over this month's figure: "October so far". */
function soFarLabel(summary: CashFlowSummary, locale: string, t: TFunction): string {
  return label(
    t("web.cashflow.monthSoFar", { month: monthName(summary.currentMonth, locale) }),
    locale,
  );
}

/* ------------------------------------------------------------------------ */
/* Dashboard tile                                                            */
/* ------------------------------------------------------------------------ */

/**
 * The daily-driver tile in the dashboard's aside. This month is the hero; last
 * month, closed, and the money paid in advance sit under it; the link goes to
 * every month on the Payments page.
 *
 * The month she just closed shows once she has taught for longer than the
 * current month, so a teacher in her first month is not shown an empty "August"
 * she was never here for. `tabular-nums` throughout, because these figures are
 * compared against themselves across visits.
 */
export async function EarningsTile({ cashFlow }: { cashFlow: CashFlow }) {
  const [t, locale] = await Promise.all([getT(), getPreferredLocale()]);
  const summary = cashFlow.primary;
  const previous = summary.months[1];
  const booked = bookedLine(summary, locale, t);
  const others = cashFlow.byCurrency.filter((s) => s.currency !== summary.currency);
  return (
    <Card>
      <CardHeader className="gap-1 pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground" as="h2">
          {t("web.cashflow.title")}
        </CardTitle>
        <p className="text-sm font-medium">{soFarLabel(summary, locale, t)}</p>
        <p className="text-h1 font-semibold tabular-nums">
          {formatMinorUnits(summary.currentMonthEarnedCents, summary.currency, locale)}
        </p>
        <CardDescription>
          {classesTaught(summary.currentMonthLessons, t)}
          {booked && <span className="block">{booked}</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="space-y-2 border-t pt-3 text-sm">
          {previous && (
            <Row
              term={label(monthName(previous.month, locale), locale)}
              detail={classesTaught(previous.lessons, t)}
              value={formatMinorUnits(previous.earnedCents, summary.currency, locale)}
            />
          )}
          <Row
            term={t("web.cashflow.paidInAdvance")}
            detail={summary.heldLessons > 0 ? classesToTeach(summary, t) : undefined}
            value={formatMinorUnits(summary.heldCents, summary.currency, locale)}
          />
        </dl>
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
                    {formatMinorUnits(other.currentMonthEarnedCents, other.currency, locale)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {/* Underlined rather than `text-primary`: that token is verified only
            as a button FILL and measures 3.48:1 as text on a raised card in
            dark mode. See the note in dashboard-view.tsx. */}
        {/* Only once there is a month to see: the history renders nothing
            until she has taught. */}
        {summary.months.length > 0 && (
          <Link
            href="/payments#earned-by-month"
            className="inline-block text-sm font-medium underline underline-offset-4"
          >
            {t("web.cashflow.seeByMonth")}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ term, detail, value }: { term: string; detail?: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">
        {term}
        {detail && <span className="block text-xs">{detail}</span>}
      </dt>
      <dd className="shrink-0 font-medium whitespace-nowrap tabular-nums">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Payments page                                                             */
/* ------------------------------------------------------------------------ */

/**
 * "Your earnings": this month, last month, paid in advance — the same three
 * answers as the dashboard tile, with room to say what "paid in advance" means
 * and what the amounts are (what students paid; D-152 on Stripe's fee).
 */
export async function EarningsSummary({ cashFlow }: { cashFlow: CashFlow }) {
  const [t, locale] = await Promise.all([getT(), getPreferredLocale()]);
  const perCurrency = cashFlow.byCurrency.length > 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg" as="h2">
          {t("web.cashflow.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {cashFlow.byCurrency.map((summary) => (
          <div key={summary.currency} className="space-y-2">
            {perCurrency && (
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("web.cashflow.inCurrency", { currency: summary.currency })}
              </h3>
            )}
            <SummaryStats summary={summary} locale={locale} t={t} />
          </div>
        ))}
        <p className="text-sm text-muted-foreground">{t("web.cashflow.paidInAdvanceHelp")}</p>
        <p className="text-xs text-muted-foreground">{t("web.cashflow.whatStudentsPaid")}</p>
      </CardContent>
    </Card>
  );
}

function SummaryStats({
  summary,
  locale,
  t,
}: {
  summary: CashFlowSummary;
  locale: string;
  t: TFunction;
}) {
  const previous = summary.months[1];
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Stat
        label={soFarLabel(summary, locale, t)}
        value={formatMinorUnits(summary.currentMonthEarnedCents, summary.currency, locale)}
        sub={classesTaught(summary.currentMonthLessons, t)}
        extra={bookedLine(summary, locale, t)}
        hero
      />
      {previous && (
        <Stat
          label={label(monthName(previous.month, locale), locale)}
          value={formatMinorUnits(previous.earnedCents, summary.currency, locale)}
          sub={classesTaught(previous.lessons, t)}
        />
      )}
      <Stat
        label={t("web.cashflow.paidInAdvance")}
        value={formatMinorUnits(summary.heldCents, summary.currency, locale)}
        sub={summary.heldLessons > 0 ? classesToTeach(summary, t) : undefined}
      />
    </div>
  );
}

function Stat({
  label: text,
  value,
  sub,
  extra,
  hero,
}: {
  label: string;
  value: string;
  sub?: string;
  extra?: string | null;
  hero?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-sm text-muted-foreground">{text}</div>
      <div className={`font-semibold tabular-nums ${hero ? "font-display text-2xl" : "text-xl"}`}>
        {value}
      </div>
      {sub ? <div className="text-sm text-muted-foreground">{sub}</div> : null}
      {extra ? <div className="text-sm text-muted-foreground">{extra}</div> : null}
    </div>
  );
}

/**
 * Every month she has taught, newest first — the notebook she used to keep.
 *
 * Each month opens (a native `<details>`, so it works with JavaScript off) to
 * the students it was taught to, which add up to the month exactly. The
 * header carries the year so far; the foot carries a typical month and the
 * lowest one, stated as facts about her own history — the figure freelancers
 * are told to budget from is the lowest month, not a hopeful average.
 *
 * A quiet month is a zero row, never a gap, because a gap hides exactly the
 * month worth seeing. The bar is a relative-size cue only and repeats the
 * number beside it, so it is hidden from assistive technology.
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
      <CardContent className="space-y-6">
        {slices.map((summary) => (
          <div key={summary.currency} className="space-y-3">
            {perCurrency && (
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("web.cashflow.inCurrency", { currency: summary.currency })}
              </h3>
            )}
            <p className="text-sm font-medium tabular-nums">
              {t("web.cashflow.byMonth.yearTotal", {
                year: summary.months[0].month.slice(0, 4),
                amount: formatMinorUnits(summary.yearToDateCents, summary.currency, locale),
              })}
            </p>
            <MonthList summary={summary} locale={locale} t={t} />
            {summary.typicalMonth && (
              <p className="border-t pt-3 text-sm text-muted-foreground">
                {t("web.cashflow.byMonth.typical", {
                  average: formatMinorUnits(
                    summary.typicalMonth.averageCents,
                    summary.currency,
                    locale,
                  ),
                  count: summary.typicalMonth.months,
                  month: monthName(summary.typicalMonth.lowest.month, locale),
                  lowest: formatMinorUnits(
                    summary.typicalMonth.lowest.earnedCents,
                    summary.currency,
                    locale,
                  ),
                })}
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function MonthList({
  summary,
  locale,
  t,
}: {
  summary: CashFlowSummary;
  locale: string;
  t: TFunction;
}) {
  const { months, currency } = summary;
  const best = Math.max(...months.map((m) => m.earnedCents));
  // The year is said only where it is not obvious: on every row once the list
  // reaches back past January, so "December" is never left to be guessed.
  const spansYears = months[0].month.slice(0, 4) !== months[months.length - 1].month.slice(0, 4);
  return (
    <ol className="divide-y divide-border">
      {months.map((m, index) => (
        <li key={m.month}>
          <MonthRow
            month={m}
            current={index === 0}
            best={best}
            currency={currency}
            name={label(monthName(m.month, locale, spansYears), locale)}
            locale={locale}
            t={t}
          />
        </li>
      ))}
    </ol>
  );
}

function MonthRow({
  month,
  current,
  best,
  currency,
  name,
  locale,
  t,
}: {
  month: MonthEarnings;
  current: boolean;
  best: number;
  currency: string;
  name: string;
  locale: string;
  t: TFunction;
}) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none space-y-1.5 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <span className="font-medium">{name}</span>
            {current && (
              <span className="text-sm text-muted-foreground">
                {" "}
                · {t("web.cashflow.byMonth.soFar")}
              </span>
            )}
            <div className="text-sm text-muted-foreground">{classesTaught(month.lessons, t)}</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-semibold whitespace-nowrap tabular-nums">
              {formatMinorUnits(month.earnedCents, currency, locale)}
            </span>
            <ChevronDown
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden
            />
          </div>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className="h-full rounded-full bg-success"
            style={{ width: best > 0 ? `${(month.earnedCents / best) * 100}%` : 0 }}
          />
        </div>
      </summary>
      {month.byStudent.length === 0 ? (
        <p className="pb-3 text-sm text-muted-foreground">{t("web.cashflow.byMonth.noClasses")}</p>
      ) : (
        <ul className="space-y-1.5 pb-3 pl-3 text-sm">
          {month.byStudent.map((s) => (
            // Name over class count, amount pinned right and never wrapped: on
            // one line at 390px the count was truncated mid-word and the
            // amount broke across "$900.00" / "MXN".
            <li key={s.studentId} className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate">{s.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {classesTaught(s.lessons, t)}
                </span>
              </span>
              <span className="shrink-0 whitespace-nowrap tabular-nums">
                {formatMinorUnits(s.earnedCents, currency, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
