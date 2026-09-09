import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { formatMinorUnits } from "@/lib/money";
import {
  groupPaymentsByMonth,
  transferState,
  transferWaitLabel,
  type MonthTotal,
} from "@/lib/payments-list";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";

/**
 * The rendering half of the payments screen: one money row, the months that
 * group them, and the "waiting on you" queue above.
 *
 * Split from `page.tsx` so that file reads as what it is — the queries, and
 * the order the answers go in.
 */

/** Everything a row needs. The page maps its Prisma payload onto this. */
export type PaymentRowData = {
  id: string;
  createdAt: Date;
  status: string;
  provider: string;
  amountMinorUnits: number;
  currency: string;
  studentName: string;
  packageName: string | null;
  paymentReference: string | null;
  studentMarkedSentAt: Date | null;
};

/**
 * Status, as one of the palette's verified badge grounds.
 *
 * `refunded` is `secondary` rather than `destructive`: a refund is a completed,
 * deliberate reversal, not a failure, and painting it red would put the one
 * status she chose herself in the same bucket as a declined card.
 */
const STATUS_VARIANT: Record<string, React.ComponentProps<typeof Badge>["variant"]> = {
  pending: "warning",
  paid: "success",
  failed: "destructive",
  refunded: "secondary",
};

const STATUS_KEY = {
  pending: "payment.status.pending",
  paid: "payment.status.paid",
  failed: "payment.status.failed",
  refunded: "payment.status.refunded",
} as const;

export function StatusBadge({ status, t }: { status: string; t: TFunction }) {
  const key = STATUS_KEY[status as keyof typeof STATUS_KEY];
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{key ? t(key) : status}</Badge>;
}

/** "Card" or "Transfer" — which rail the money came down, in her words. */
function methodLabel(provider: string, t: TFunction): string {
  return provider === "stripe" ? t("web.payments.method.card") : t("web.payments.method.transfer");
}

/**
 * One payment.
 *
 * FOUR CELLS, PLACED EXPLICITLY, so the same DOM reads correctly at both
 * widths with nothing duplicated and nothing hidden: on a phone the name and
 * the amount share the first line and the detail and the status share the
 * second; from `lg` the four fan out into columns. Explicit `col-start` /
 * `row-start` is what makes that possible — a wrapping flex row cannot put the
 * fourth child on line one and the third on line two.
 *
 * The amount is `tabular-nums` and right-aligned at every width, because it is
 * the column the eye runs down and the figures have to line up on the decimal
 * point for the list to be scannable as money at all.
 *
 * The row carries no focus styling of its own: globals.css draws a 3px `--ring`
 * outline on every `:focus-visible`, which around a full-width row is exactly
 * right. Overriding it would be more code for a worse, less consistent result.
 */
export function PaymentRow({
  payment,
  day,
  t,
}: {
  payment: PaymentRowData;
  /** Formats a date in the teacher's zone and locale — built once by the ledger. */
  day: Intl.DateTimeFormat;
  t: TFunction;
}) {
  // A refund left again; a failed charge never arrived. Neither is income, and
  // an amount printed at full weight in the column she reads as earnings says
  // that it is. Struck through for the reversal, muted for the one that never
  // happened — the same two states the badge names, said again where the eye
  // actually lands.
  const refunded = payment.status === "refunded";
  const notIncome = refunded || payment.status === "failed";

  const meta = [
    day.format(payment.createdAt),
    payment.packageName ?? t("web.payments.detail.package"),
    methodLabel(payment.provider, t),
  ].join(" · ");

  return (
    <li>
      <Link
        href={`/payments/${payment.id}`}
        className={cn(
          "grid grid-cols-ledger items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-muted/40",
          "lg:grid-cols-ledger-wide lg:gap-y-0",
        )}
      >
        <span className="col-start-1 row-start-1 min-w-0 truncate font-medium">
          {payment.studentName}
        </span>

        <span className="col-start-1 row-start-2 min-w-0 truncate text-xs text-muted-foreground lg:col-start-2 lg:row-start-1 lg:text-sm">
          {meta}
        </span>

        <span className="col-start-2 row-start-2 justify-self-end lg:col-start-3 lg:row-start-1 lg:justify-self-start">
          <StatusBadge status={payment.status} t={t} />
        </span>

        <span
          className={cn(
            "col-start-2 row-start-1 justify-self-end font-semibold tabular-nums lg:col-start-4",
            notIncome && "text-muted-foreground",
            refunded && "line-through",
          )}
        >
          {formatMinorUnits(payment.amountMinorUnits, payment.currency)}
        </span>
      </Link>
    </li>
  );
}

/**
 * The ledger: one framed object, divided into calendar months.
 *
 * A FRAME RATHER THAN LOOSE ROWS. The first pass let the rows and the month
 * rules bleed a few pixels past the cards above them, so that a hovered row
 * read as a band. It did — and it also meant no two horizontal edges on the
 * page lined up. One bordered container gets both: the frame aligns with the
 * cards, and the hover band is the frame's full width with the text sitting
 * comfortably inside it.
 *
 * MONTHS ARE BANDS, NOT HEADINGS FLOATING ABOVE GROUPS. Inside a frame a
 * filled row reads as a divider in a way a bare heading cannot, and it gives
 * the subtotal somewhere to sit that is obviously about the rows below it.
 * Grouping at all is what turns a page of rows into something navigable: a
 * landmark every screenful, and a subtotal where "how much came in in August?"
 * is actually asked.
 */
export function PaymentLedger({
  payments,
  received,
  timeZone,
  locale,
  t,
}: {
  payments: PaymentRowData[];
  /**
   * Month key (`YYYY-MM`) to what landed that month. Computed by the page over
   * the WHOLE month rather than over this page of rows — see `receivedByMonth`.
   * A month with nothing received is simply absent.
   */
  received: Map<string, MonthTotal[]>;
  timeZone: string;
  locale: string;
  t: TFunction;
}) {
  const months = groupPaymentsByMonth(payments, timeZone);
  // Built once and passed down rather than per row: `Intl.DateTimeFormat` is
  // expensive to construct and this renders inside a list.
  const day = new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" });
  // Formatted in UTC, not her zone: the value is a midday-UTC marker for the
  // month rather than a real instant (see `LedgerMonth.date`).
  const monthHeading = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border bg-card">
      {months.map((month) => {
        const totals = received.get(month.key) ?? [];
        return (
          <section key={month.key} aria-labelledby={`month-${month.key}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border bg-muted/50 px-4 py-2">
              {/* `capitalize` because ICU lower-cases month names in Spanish and
                  French ("septiembre 2026"), and a heading should not. */}
              <Heading
                level={4}
                as="h3"
                id={`month-${month.key}`}
                className="capitalize text-muted-foreground"
              >
                {monthHeading.format(month.date)}
              </Heading>
              {totals.length > 0 && (
                <p className="text-sm tabular-nums text-muted-foreground">
                  {totals
                    .map((total) =>
                      t("web.payments.ledger.received", {
                        amount: formatMinorUnits(total.cents, total.currency),
                      }),
                    )
                    .join(" · ")}
                </p>
              )}
            </div>
            <ul className="divide-y divide-border">
              {month.entries.map((payment) => (
                <PaymentRow key={payment.id} payment={payment} day={day} t={t} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The one thing on this screen that is a JOB rather than a record.
 *
 * A manual-transfer payment sits `pending` until she confirms the money
 * arrived, and the package stays locked until she does — so a forgotten
 * confirmation is a student who paid and cannot book. Chronological order
 * buries those among however many card payments settled since; this pulls them
 * out and sorts them oldest-wait first, which is the one that has been broken
 * longest.
 *
 * It lists ONLY transfers the student has marked sent. A pending transfer she
 * cannot act on yet is not a job, and a queue full of things you cannot do is
 * a queue people learn to skip.
 *
 * Rows use the same two-column grid as the ledger, so they hold together on a
 * phone: name against amount, then the wait against the date. The first
 * version was a flex row with the amount and date stacked at the end, which at
 * 390px truncated the student's name to "Mira Sofía R…" and wrapped the
 * reference around the amount.
 */
export function ConfirmQueue({
  payments,
  totalCount,
  moreHref,
  now,
  day,
  t,
}: {
  payments: PaymentRowData[];
  /** Everything waiting, which may be more than this card lists. */
  totalCount: number;
  moreHref: string;
  now: Date;
  day: Intl.DateTimeFormat;
  t: TFunction;
}) {
  return (
    // A warning-tinted BORDER rather than a warning-tinted card. The section is
    // the page's call to action, so it has to separate from the neutral cards
    // around it — but a full `warning-bg` panel would shout at the volume of an
    // error every time a student pays by transfer, which is routine.
    <Card className="border-warning/40">
      <CardHeader className="gap-1.5">
        <CardTitle className="flex items-center gap-2 text-lg" as="h2">
          {t("web.payments.confirm.title")}
          <Badge variant="warning">{totalCount}</Badge>
        </CardTitle>
        <CardDescription>{t("web.payments.confirm.body")}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border border-t">
          {payments.map((payment) => {
            const state = transferState(payment.studentMarkedSentAt, now);
            const wait = transferWaitLabel(state);
            return (
              <li key={payment.id}>
                <Link
                  href={`/payments/${payment.id}`}
                  className="grid grid-cols-ledger items-center gap-x-4 gap-y-1 px-6 py-3 transition-colors hover:bg-muted/40"
                >
                  <span className="col-start-1 row-start-1 min-w-0 truncate font-medium">
                    {payment.studentName}
                  </span>

                  <span className="col-start-1 row-start-2 min-w-0 truncate text-xs text-muted-foreground">
                    {wait && (
                      <span className={cn(state.state === "overdue" && "font-medium text-warning")}>
                        {t(wait.key, wait.vars)}
                      </span>
                    )}
                    {/* The reference is what she matches against her bank
                        statement, so it earns its place — but only where there
                        is room for it. At 390px it would push the wait, which
                        is the part that says whether this is urgent, out of
                        view. */}
                    {payment.paymentReference && (
                      <span className="hidden sm:inline">
                        {" · "}
                        {t("web.payments.confirm.reference")}{" "}
                        <span className="font-mono">{payment.paymentReference}</span>
                      </span>
                    )}
                  </span>

                  <span className="col-start-2 row-start-1 justify-self-end font-semibold tabular-nums">
                    {formatMinorUnits(payment.amountMinorUnits, payment.currency)}
                  </span>

                  <span className="col-start-2 row-start-2 justify-self-end text-xs text-muted-foreground">
                    {day.format(payment.createdAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        {totalCount > payments.length && (
          <div className="border-t px-6 py-3">
            <Link href={moreHref} className="text-sm font-medium underline underline-offset-4">
              {t("web.payments.confirm.cta")}
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
