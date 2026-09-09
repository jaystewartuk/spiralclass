import { requireSuperuser, listFilterableTeachers } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { resolveSort, type SortColumns } from "@/lib/table-sort";
import { resolvePage } from "@/lib/pagination";
import { getT } from "@/lib/i18n";
import { Pagination } from "@/components/ui/pagination";
import type { OverrideTargetType, Prisma } from "@prisma/client";
import { AuditTable } from "./audit-table";

const PAGE_SIZE = 100;

const TARGET_TYPES: OverrideTargetType[] = [
  "booking",
  "package",
  "payment",
  "student",
  "teacher",
  "system",
];

const SORT_COLUMNS: SortColumns<Prisma.OverrideOrderByWithRelationInput> = {
  when: (dir) => ({ createdAt: dir }),
  action: (dir) => ({ action: dir }),
};

type Search = {
  q?: string;
  targetType?: string;
  teacherId?: string;
  sort?: string;
  dir?: string;
  page?: string;
};

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireSuperuser();
  const t = await getT();
  const params = await searchParams;
  const { q, targetType, teacherId } = params;
  const query = (q ?? "").trim();
  const targetTypeFilter = TARGET_TYPES.includes(targetType as OverrideTargetType)
    ? (targetType as OverrideTargetType)
    : undefined;
  const { orderBy } = resolveSort(params, SORT_COLUMNS, "when");
  const teachers = await listFilterableTeachers();

  const where: Prisma.OverrideWhereInput = {
    ...(query
      ? {
          OR: [
            { action: { contains: query, mode: "insensitive" } },
            { reason: { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(targetTypeFilter ? { targetType: targetTypeFilter } : {}),
    ...(teacherId === "platform" ? { teacherId: null } : teacherId ? { teacherId } : {}),
  };

  const total = await prisma.override.count({ where });
  const pageState = resolvePage(params, total, PAGE_SIZE);
  const overrides = await prisma.override.findMany({
    where,
    orderBy,
    skip: pageState.skip,
    take: pageState.take,
    include: {
      teacher: { select: { name: true, email: true } },
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.audit.title")} />
        <p className="text-sm text-muted-foreground">{t("web.admin.audit.subtitle")}</p>
      </header>

      <AuditTable
        initialOverrides={overrides}
        targetTypes={TARGET_TYPES}
        teachers={teachers}
        params={params}
      />

      {total > 0 ? <Pagination state={pageState} params={params} /> : null}
    </div>
  );
}
