import { requireSuperuser, listFilterableTeachers } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { resolveSort, type SortColumns } from "@/lib/table-sort";
import { resolvePage } from "@/lib/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { CategoryBarChart, CHART_CATEGORY_COLORS } from "@/components/ui/chart";
import { toBarSeries, type ChartDatum } from "@spiralclass/shared";
import type { Prisma } from "@prisma/client";
import { getT } from "@/lib/i18n";
import { StudentsTable } from "./students-table";

const PAGE_SIZE = 50;

const SORT_COLUMNS: SortColumns<Prisma.StudentOrderByWithRelationInput> = {
  name: (dir) => ({ name: dir }),
  joined: (dir) => ({ createdAt: dir }),
  bookings: (dir) => ({ bookings: { _count: dir } }),
  packages: (dir) => ({ packages: { _count: dir } }),
};

type Search = { q?: string; teacherId?: string; sort?: string; dir?: string; page?: string };

export default async function AdminStudentsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireSuperuser();
  const t = await getT();
  const params = await searchParams;
  const { q, teacherId } = params;
  const query = (q ?? "").trim();
  const { orderBy } = resolveSort(params, SORT_COLUMNS, "joined");
  const teachers = await listFilterableTeachers();

  const where: Prisma.StudentWhereInput = {
    ...(query
      ? {
          OR: [
            { email: { contains: query, mode: "insensitive" } },
            { name: { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(teacherId ? { teacherStudents: { some: { teacherId } } } : {}),
  };

  const [total, disabledCount] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.count({ where: { ...where, disabledAt: { not: null } } }),
  ]);
  const statusMix: ChartDatum[] = toBarSeries(
    { active: total - disabledCount, disabled: disabledCount },
    ["active", "disabled"] as const,
    { active: t("web.admin.students.active"), disabled: t("web.admin.disabledBadge") },
    { active: CHART_CATEGORY_COLORS[0], disabled: CHART_CATEGORY_COLORS[1] },
  );
  const pageState = resolvePage(params, total, PAGE_SIZE);
  const students = await prisma.student.findMany({
    where,
    orderBy,
    skip: pageState.skip,
    take: pageState.take,
    select: {
      id: true,
      email: true,
      name: true,
      disabledAt: true,
      disabledReason: true,
      createdAt: true,
      _count: { select: { bookings: true, packages: true } },
      teacherStudents: { select: { teacher: { select: { id: true, name: true } } } },
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.students.title")} />
        <p className="text-sm text-muted-foreground">{t("web.admin.students.subtitle")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.common.statusMixTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryBarChart data={statusMix} />
        </CardContent>
      </Card>

      <StudentsTable initialStudents={students} teachers={teachers} params={params} />

      {total > 0 ? <Pagination state={pageState} params={params} /> : null}
    </div>
  );
}
