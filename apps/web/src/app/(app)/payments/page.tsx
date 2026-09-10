import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Download, Wallet } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Heading } from "@/components/ui/heading";
import { Pagination } from "@/components/ui/pagination";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { computeTeacherCashFlow } from "@/lib/cashflow";
import { CashFlowPanel } from "@/components/cashflow-summary";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { resolvePage } from "@/lib/pagination";
import { zonedWallClockToUtc } from "@/lib/tz";
import {
  PAYMENTS_PAGE_SIZE,
  PAYMENTS_SCOPE_STATUSES,
  normalizePaymentSearch,
  paymentsHref,
  monthKey,
  nextMonthKey,
  paymentsQuery,
  receivedByMonth,
  resolvePaymentsScope,
  type MonthTotal,
} from "@/lib/payments-list";
import { CopyLinkButton } from "@/components/copy-link-button";
import { PaymentsToolbar } from "./payments-toolbar";
import { ConfirmQueue, PaymentLedger, type PaymentRowData } from "./payments-view";

/**
 * The teacher's money.
 *
 * The screen answers, in this order, the three questions she opens it with:
 * how am I doing, what needs me right now, and where did a particular payment
 * go. The previous version answered only the first, and only partly — it was a
 * cash-flow card over a flat, unfiltered, unsearchable list hard-capped at the
 * fifty most recent payments, with nothing beyond the fiftieth reachable from
 * anywhere in the product.
 *
 * FOUR THINGS ABOUT THE SHAPE, since each is a decision rather than a default:
 *
 *  1. THE QUEUE IS SEPARATE FROM THE LEDGER. A transfer the student has marked
 *     sent is the only thing on this page she can act on, and until she
 *     confirms it the student has paid and still cannot book. In a
 *     reverse-chronological list it sits wherever it happened to land. It gets
 *     its own section, sorted by who has waited longest.
 *  2. THE WHOLE HISTORY IS REACHABLE. Twenty-five to a page with real
 *     pagination, replacing `take: 50`. Money is the one record a teacher goes
 *     back through a year later, at tax time, for a payment she can name but
 *     not date — hence the search and the CSV export as well.
 *  3. GROUPED BY CALENDAR MONTH, with a per-month "received" subtotal. That is
 *     the unit she does her books in, and it gives the eye a landmark every
 *     screenful instead of an undifferentiated run of rows.
 *  4. THE VIEWS ARE URLS, not client state — see `PaymentsToolbar`.
 *
 * Tenancy: every query is filtered through `package.teacherId` from auth.
 */

/** How many of the waiting transfers the queue card lists before it links out. */
const CONFIRM_QUEUE_LIMIT = 5;

const PAYMENT_SELECT = {
  id: true,
  createdAt: true,
  status: true,
  provider: true,
  amountMinorUnits: true,
  currency: true,
  paymentReference: true,
  studentMarkedSentAt: true,
  package: {
    select: {
      student: { select: { name: true } },
      template: { select: { name: true } },
    },
  },
} satisfies Prisma.PaymentSelect;

type PaymentPayload = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

function toRow(payment: PaymentPayload): PaymentRowData {
  return {
    id: payment.id,
    createdAt: payment.createdAt,
    status: payment.status,
    provider: payment.provider,
    amountMinorUnits: payment.amountMinorUnits,
    currency: payment.currency,
    studentName: payment.package.student.name,
    packageName: payment.package.template?.name ?? null,
    paymentReference: payment.paymentReference,
    studentMarkedSentAt: payment.studentMarkedSentAt,
  };
}

export default async function PaymentsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [teacher, locale, t, params] = await Promise.all([
    requireOnboardedTeacher(),
    getPreferredLocale(),
    getT(),
    searchParams,
  ]);

  const scope = resolvePaymentsScope(params.show);
  const search = normalizePaymentSearch(params.q);
  const now = new Date();
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const bookingUrl = `${appUrl}/b/${teacher.bookingSlug}`;

  const mine: Prisma.PaymentWhereInput = { package: { teacherId: teacher.id } };
  const statuses = PAYMENTS_SCOPE_STATUSES[scope];
  // Composed as an explicit `AND` rather than a spread. The clauses are
  // independent — tenancy, view, search — and one of the search branches
  // (`paymentReference`) carries no teacher constraint of its own, so an edit
  // that dropped `mine` from a spread would silently make it the only
  // predicate on a cross-tenant money query. `AND` makes that impossible to do
  // by accident.
  //
  // Name, email, and the reference token she pastes off a bank statement are
  // the three things a teacher actually has in hand when hunting one down.
  const where: Prisma.PaymentWhereInput = {
    AND: [
      mine,
      ...(statuses ? [{ status: { in: [...statuses] } }] : []),
      ...(search
        ? [
            {
              OR: [
                {
                  package: {
                    student: { name: { contains: search, mode: "insensitive" as const } },
                  },
                },
                {
                  package: {
                    student: { email: { contains: search, mode: "insensitive" as const } },
                  },
                },
                { paymentReference: { contains: search, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
    ],
  };

  // The queue is a standing fact about her money, so it is NOT filtered by the
  // current view or search: switching to "Paid" must not make a student who is
  // waiting on confirmation disappear from the screen.
  const awaitingWhere: Prisma.PaymentWhereInput = {
    ...mine,
    provider: "manual_transfer",
    status: "pending",
    studentMarkedSentAt: { not: null },
    confirmedAt: null,
  };

  const [total, everTook, awaitingCount, awaiting, cashFlow] = await Promise.all([
    prisma.payment.count({ where }),
    // "Has she ever taken a payment at all?" — what separates the first-run
    // empty state (here is your link) from an empty filter (nothing matches).
    // Not derivable from the cash-flow total, which counts only paid packages.
    prisma.payment.count({ where: mine }),
    // Counted separately from the page it renders. Deriving the total from a
    // capped `findMany` would report "5" to a teacher with twenty students
    // waiting — both in the queue's own badge and on the "Awaiting" tab.
    prisma.payment.count({ where: awaitingWhere }),
    prisma.payment.findMany({
      where: awaitingWhere,
      // Oldest wait first: that is the one that has been broken longest, and
      // the one the reminder cron is already nagging her about.
      orderBy: { studentMarkedSentAt: "asc" },
      take: CONFIRM_QUEUE_LIMIT,
      select: PAYMENT_SELECT,
    }),
    computeTeacherCashFlow(teacher.id, now),
  ]);

  const page = resolvePage(
    { page: typeof params.page === "string" ? params.page : undefined },
    total,
    PAYMENTS_PAGE_SIZE,
  );

  const payments = total
    ? await prisma.payment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: page.skip,
        take: page.take,
        select: PAYMENT_SELECT,
      })
    : [];

  // The month subtotals are about the MONTH, not about this page of rows.
  // Summing what is on screen would print a different August total on page 1
  // than on page 2, each a slice presented as a month — so the months this
  // page touches get re-read in full. The alternative was raw SQL with a
  // `date_trunc` in her timezone, for a query that stays small: an unfiltered
  // page spans two or three months, and even a sparse search that reaches back
  // years reads four narrow columns of one teacher's paid rows.
  const received = await monthTotalsFor(payments, teacher.id, teacher.timezone);

  const queue = awaiting.map(toRow);
  const day = new Intl.DateTimeFormat(locale, {
    timeZone: teacher.timezone,
    day: "numeric",
    month: "short",
  });

  // First run: she has never taken a payment. One thing to do, so the page is
  // that one thing rather than a ledger, a filter bar and three empty views.
  if (everTook === 0) {
    return (
      <PageShell width="default">
        <PageHeader title={t("web.payments.title")} description={t("web.payments.subtitle")} />
        <Card>
          <CardHeader>
            <CardTitle className="text-lg" as="h2">
              {t("web.payments.emptyTitle")}
            </CardTitle>
            <CardDescription>{t("web.payments.emptyBody")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">
              {t("web.payments.emptyShareLead")}
            </p>
            <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all">
              {bookingUrl}
            </div>
            <CopyLinkButton value={bookingUrl} />
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("web.payments.title")}
        description={t("web.payments.subtitle")}
        actions={
          // A plain link, not a client-side download: the route streams a CSV
          // with a Content-Disposition, so this works with JavaScript off. The
          // href is built by the same function as the page's own links, so the
          // file she gets is exactly the selection she is looking at.
          <Button asChild variant="outline">
            <a href={`/api/teacher/payments/export${paymentsQuery(scope, search)}`}>
              <Download className="size-4" aria-hidden />
              {t("web.payments.export")}
            </a>
          </Button>
        }
      />

      {cashFlow.byCurrency.some((s) => s.totalPaidCents > 0) && (
        <CashFlowPanel cashFlow={cashFlow} />
      )}

      {queue.length > 0 && (
        <ConfirmQueue
          payments={queue}
          totalCount={awaitingCount}
          moreHref={paymentsHref("pending")}
          now={now}
          day={day}
          t={t}
        />
      )}

      <section className="space-y-4" aria-labelledby="payments-ledger">
        <Heading level={3} as="h2" id="payments-ledger">
          {t("web.payments.ledger.title")}
        </Heading>

        <PaymentsToolbar scope={scope} search={search} needsConfirmCount={awaitingCount} t={t} />

        {payments.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={t("web.payments.noResultsTitle")}
            description={t("web.payments.noResultsBody")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={paymentsHref("all")}>{t("web.payments.view.all")}</Link>
              </Button>
            }
          />
        ) : (
          <>
            <PaymentLedger
              payments={payments.map(toRow)}
              received={received}
              timeZone={teacher.timezone}
              locale={locale}
              t={t}
            />
            <Pagination
              state={page}
              params={{
                show: scope === "all" ? undefined : scope,
                q: search || undefined,
              }}
              labels={{
                showing: t("common.pagination.showing"),
                of: t("common.pagination.of"),
                noResults: t("common.pagination.noResults"),
                page: t("common.pagination.page"),
                prev: t("common.pagination.prev"),
                next: t("common.pagination.next"),
              }}
            />
          </>
        )}
      </section>
    </PageShell>
  );
}

/**
 * What landed in each calendar month this page touches, per currency.
 *
 * Bounded by the first and last row ON THE PAGE, widened out to whole months
 * in the teacher's zone — so a page showing 2 September back to 18 August
 * re-reads all of August and all of September and nothing else. Empty when the
 * page is, which is also when there is no heading to put a total under.
 */
async function monthTotalsFor(
  page: readonly { createdAt: Date }[],
  teacherId: string,
  timeZone: string,
) {
  if (page.length === 0) return new Map<string, MonthTotal[]>();

  // The page is ordered newest first, so the ends of the array are the bounds.
  const newest = page[0].createdAt;
  const oldest = page[page.length - 1].createdAt;
  const from = zonedWallClockToUtc(`${monthKey(oldest, timeZone)}-01`, "00:00", timeZone);
  const to = zonedWallClockToUtc(
    `${nextMonthKey(monthKey(newest, timeZone))}-01`,
    "00:00",
    timeZone,
  );

  const rows = await prisma.payment.findMany({
    where: {
      AND: [{ package: { teacherId } }, { status: "paid" }, { createdAt: { gte: from, lt: to } }],
    },
    select: { createdAt: true, status: true, amountMinorUnits: true, currency: true },
  });
  return receivedByMonth(rows, timeZone);
}
