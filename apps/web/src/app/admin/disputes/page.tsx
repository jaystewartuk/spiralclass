import { requireSuperuser } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { getT } from "@/lib/i18n";
import { resolveSort, type SortColumns } from "@/lib/table-sort";
import { resolvePage } from "@/lib/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryBarChart, CHART_CATEGORY_COLORS } from "@/components/ui/chart";
import { Pagination } from "@/components/ui/pagination";
import type { DisputeStatus, Prisma } from "@prisma/client";
import { toBarSeries } from "@spiralclass/shared";
import { DisputesTable } from "./disputes-table";

// Mirrors the table's own badge logic (needs_response=destructive,
// non-final=warning, final=resolved) rather than charting all 8 raw
// DisputeStatus enum values — with dispute volume typically in the single
// digits, an 8-bar per-status chart would be noise; these 3 buckets are the
// distinction the page already cares about.
const BUCKET_COLORS = {
  needsResponse: CHART_CATEGORY_COLORS[1],
  inProgress: CHART_CATEGORY_COLORS[0],
  resolved: "hsl(var(--muted-foreground))",
};

const PAGE_SIZE = 100;

// docs/security.md. One row per Stripe `dp_*`; upserted by
// the webhook handler. Surfaces evidence-due-by prominently so a
// `needs_response` dispute doesn't slip past us.

// Every column keeps "still-open first" (isFinal asc) as the primary key so a
// live dispute never sinks below resolved noise, then applies the user's chosen
// order. Columns return arrays so the compound default shares one orderBy type.
const SORT_COLUMNS: SortColumns<Prisma.DisputeOrderByWithRelationInput[]> = {
  opened: (dir) => [{ isFinal: "asc" }, { createdAt: dir }],
  due: (dir) => [{ isFinal: "asc" }, { evidenceDueBy: dir }],
  status: (dir) => [{ isFinal: "asc" }, { status: dir }],
  amount: (dir) => [{ isFinal: "asc" }, { amountMinorUnits: dir }],
};

const STATUSES: DisputeStatus[] = [
  "needs_response",
  "warning_needs_response",
  "warning_under_review",
  "under_review",
  "warning_closed",
  "charge_refunded",
  "won",
  "lost",
];

type Search = { status?: string; sort?: string; dir?: string; page?: string };

export default async function AdminDisputesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireSuperuser();
  const t = await getT();
  const params = await searchParams;
  const statusFilter = STATUSES.includes(params.status as DisputeStatus)
    ? (params.status as DisputeStatus)
    : undefined;
  const { orderBy } = resolveSort(params, SORT_COLUMNS, "opened");
  const where: Prisma.DisputeWhereInput = statusFilter ? { status: statusFilter } : {};

  // These three counters always span every dispute, not just the filtered
  // set — a filtered-out "needs response" dispute must never disappear from
  // the always-visible headline stat, only from the table below it.
  const [total, openCount, needsResponseCount, filteredTotal] = await Promise.all([
    prisma.dispute.count(),
    prisma.dispute.count({ where: { isFinal: false } }),
    prisma.dispute.count({ where: { status: "needs_response" } }),
    prisma.dispute.count({ where }),
  ]);
  const statusMix = toBarSeries(
    {
      needsResponse: needsResponseCount,
      inProgress: openCount - needsResponseCount,
      resolved: total - openCount,
    },
    ["needsResponse", "inProgress", "resolved"] as const,
    {
      needsResponse: t("web.admin.disputes.needsResponse"),
      inProgress: t("web.admin.disputes.inProgress"),
      resolved: t("web.admin.disputes.resolved"),
    },
    BUCKET_COLORS,
  );
  const pageState = resolvePage(params, filteredTotal, PAGE_SIZE);

  const disputes = await prisma.dispute.findMany({
    where,
    orderBy,
    skip: pageState.skip,
    take: pageState.take,
    include: {
      payment: {
        select: {
          id: true,
          package: {
            select: {
              id: true,
              teacher: { select: { id: true, name: true, email: true } },
              student: { select: { name: true, email: true } },
            },
          },
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.disputes.title")} />
        <p className="text-sm text-muted-foreground">
          {t("web.admin.disputes.intro.pre")} <code>charge.dispute.*</code>{" "}
          {t("web.admin.disputes.intro.post")}
        </p>
        <p className="mt-2 text-sm">
          {t("web.admin.disputes.open")}: <span className="font-semibold">{openCount}</span> —{" "}
          {t("web.admin.disputes.needsResponse")}:{" "}
          <span className={`font-semibold ${needsResponseCount > 0 ? "text-destructive" : ""}`}>
            {needsResponseCount}
          </span>
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.common.statusMixTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryBarChart data={statusMix} />
        </CardContent>
      </Card>

      <DisputesTable initialDisputes={disputes} statuses={STATUSES} params={params} />

      {filteredTotal > 0 ? <Pagination state={pageState} params={params} /> : null}

      <p className="text-xs text-muted-foreground">{t("web.admin.disputes.footer")}</p>
    </div>
  );
}
