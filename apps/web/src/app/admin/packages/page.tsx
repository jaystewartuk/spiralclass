import { requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { resolveSort, type SortColumns } from "@/lib/table-sort";
import { resolvePage } from "@/lib/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryBarChart, CHART_CATEGORY_COLORS } from "@/components/ui/chart";
import { Pagination } from "@/components/ui/pagination";
import { toBarSeries } from "@spiralclass/shared";
import type { PackageStatus, Prisma } from "@prisma/client";
import { getT } from "@/lib/i18n";
import { PackagesTable } from "./packages-table";

const STATUSES: PackageStatus[] = ["pending", "active", "paused", "expired", "refunded"];
const PAGE_SIZE = 100;

// 5 statuses, only 4 validated chart colors — `refunded` (rarest, an edge
// case rather than a lifecycle stage) gets the neutral overflow color, same
// convention as the Money page's "unknown rail" bucket.
const STATUS_COLORS: Record<PackageStatus, string> = {
  pending: CHART_CATEGORY_COLORS[0],
  active: CHART_CATEGORY_COLORS[1],
  paused: CHART_CATEGORY_COLORS[2],
  expired: CHART_CATEGORY_COLORS[3],
  refunded: "hsl(var(--muted-foreground))",
};

const SORT_COLUMNS: SortColumns<Prisma.PackageOrderByWithRelationInput> = {
  created: (dir) => ({ createdAt: dir }),
  classes: (dir) => ({ classesTotal: dir }),
  expires: (dir) => ({ expiresAt: dir }),
  status: (dir) => ({ status: dir }),
  paid: (dir) => ({ pricePaidMinorUnits: dir }),
};

type Search = { q?: string; status?: string; sort?: string; dir?: string; page?: string };

export default async function AdminPackagesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireAdmin("support");
  const t = await getT();
  const params = await searchParams;
  const { q, status } = params;
  const query = (q ?? "").trim();
  const statusFilter = STATUSES.includes(status as PackageStatus)
    ? (status as PackageStatus)
    : undefined;
  const { orderBy } = resolveSort(params, SORT_COLUMNS, "created");

  const where: Prisma.PackageWhereInput = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(query
      ? {
          OR: [
            { teacher: { is: { name: { contains: query, mode: "insensitive" } } } },
            { teacher: { is: { email: { contains: query, mode: "insensitive" } } } },
            { student: { is: { name: { contains: query, mode: "insensitive" } } } },
            { student: { is: { email: { contains: query, mode: "insensitive" } } } },
            { template: { is: { name: { contains: query, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };

  const [total, statusCounts] = await Promise.all([
    prisma.package.count({ where }),
    prisma.package.groupBy({ by: ["status"], where, _count: { _all: true } }),
  ]);
  const statusMix = toBarSeries(
    Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])) as Partial<
      Record<PackageStatus, number>
    >,
    STATUSES,
    Object.fromEntries(STATUSES.map((s) => [s, t(`package.status.${s}`)])) as Record<
      PackageStatus,
      string
    >,
    STATUS_COLORS,
  );
  const pageState = resolvePage(params, total, PAGE_SIZE);
  const packages = await prisma.package.findMany({
    where,
    orderBy,
    skip: pageState.skip,
    take: pageState.take,
    select: {
      id: true,
      classesTotal: true,
      classesUsed: true,
      pricePaidMinorUnits: true,
      expiresAt: true,
      status: true,
      createdAt: true,
      teacher: { select: { name: true } },
      student: { select: { name: true } },
      template: { select: { name: true } },
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.packages.title")} />
        <p className="text-sm text-muted-foreground">
          {t("web.admin.packages.matchingCount", { count: total.toLocaleString() })}
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

      <PackagesTable initialPackages={packages} statuses={STATUSES} params={params} />

      {total > 0 ? <Pagination state={pageState} params={params} /> : null}
    </div>
  );
}
