import { requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { buildPaymentWhere, PAYMENT_STATUSES } from "@/lib/admin-filters";
import { prisma } from "@/lib/prisma";
import { formatMinorUnits } from "@/lib/money";
import { resolveSort, type SortColumns } from "@/lib/table-sort";
import { resolvePage } from "@/lib/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryBarChart } from "@/components/ui/chart";
import { Pagination } from "@/components/ui/pagination";
import type { PaymentStatus, Prisma } from "@prisma/client";
import { toBarSeries } from "@spiralclass/shared";
import { getT } from "@/lib/i18n";
import { PaymentsTable } from "./payments-table";

const PAGE_SIZE = 100;

// Reuses the same status→tone mapping as StatusBadge below, so a status
// always reads the same color whether it's a badge or a chart bar.
const STATUS_COLORS: Record<PaymentStatus, string> = {
  pending: "hsl(var(--warning))",
  paid: "hsl(var(--success))",
  failed: "hsl(var(--destructive))",
  refunded: "hsl(var(--muted-foreground))",
};

const SORT_COLUMNS: SortColumns<Prisma.PaymentOrderByWithRelationInput> = {
  date: (dir) => ({ createdAt: dir }),
  status: (dir) => ({ status: dir }),
  amount: (dir) => ({ amountMinorUnits: dir }),
};

type Search = {
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  page?: string;
};

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const actor = await requireAdmin("finance");
  const t = await getT();
  const params = await searchParams;
  const { q, status, from, to } = params;
  const query = (q ?? "").trim();
  const statusFilter = PAYMENT_STATUSES.includes(status as PaymentStatus)
    ? (status as PaymentStatus)
    : undefined;
  const { orderBy } = resolveSort(params, SORT_COLUMNS, "date");
  const where = buildPaymentWhere({ q, status, from, to });

  const [grossPaidAgg, totalCount, statusCounts] = await Promise.all([
    prisma.payment.aggregate({
      where: { ...where, status: "paid" },
      _sum: { amountMinorUnits: true },
    }),
    prisma.payment.count({ where }),
    prisma.payment.groupBy({ by: ["status"], where, _count: { _all: true } }),
  ]);
  const statusLabels: Record<PaymentStatus, string> = {
    pending: t("web.admin.common.statusPending"),
    paid: t("web.admin.common.statusPaid"),
    failed: t("web.admin.common.statusFailed"),
    refunded: t("web.admin.common.statusRefunded"),
  };
  const statusChartData = toBarSeries(
    Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])) as Partial<
      Record<PaymentStatus, number>
    >,
    PAYMENT_STATUSES,
    statusLabels,
    STATUS_COLORS,
  );
  const pageState = resolvePage(params, totalCount, PAGE_SIZE);
  const payments = await prisma.payment.findMany({
    where,
    orderBy,
    skip: pageState.skip,
    take: pageState.take,
    include: {
      package: {
        select: {
          id: true,
          template: { select: { name: true } },
          student: { select: { name: true, email: true } },
          teacher: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });

  const grossPaid = grossPaidAgg._sum.amountMinorUnits ?? 0;

  const exportHref = new URLSearchParams(
    Object.entries({ q: query, status: statusFilter ?? "", from: from ?? "", to: to ?? "" }).filter(
      ([, v]) => v,
    ),
  ).toString();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageHeader title={t("web.admin.payments.title")} />
          <p className="text-muted-foreground text-sm">
            {t("web.admin.payments.matchingCount", { count: totalCount.toLocaleString() })}
          </p>
          <p className="mt-2 text-sm">
            {t("web.admin.payments.grossPaidFiltered")}:{" "}
            <span className="font-semibold">{formatMinorUnits(grossPaid)}</span>
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/admin/export/payments${exportHref ? `?${exportHref}` : ""}`}>
            {t("web.admin.payments.exportCsv")}
          </a>
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.payments.statusMixFiltered")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryBarChart data={statusChartData} />
        </CardContent>
      </Card>

      <PaymentsTable
        initialPayments={payments}
        statusLabels={statusLabels}
        canRefund={actor.role !== "support"}
        params={params}
      />

      {totalCount > 0 ? <Pagination state={pageState} params={params} /> : null}
    </div>
  );
}
