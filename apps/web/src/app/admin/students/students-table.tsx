"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable, type AdminColumnDef, type SortState } from "@/components/ui/data-table";
import { DebouncedSearchInput } from "@/components/ui/debounced-search";
import { FilterBar, FilterField, FilterSelect } from "@/components/ui/filter-bar";
import { RowLink, TableShell } from "@/components/ui/table";
import { matchesStudentFilters } from "@/lib/admin-filters";
import { useDebouncedSubmit } from "@/lib/use-debounced-submit";
import { useT } from "@/components/locale-provider";

const SERVER_SORTABLE = new Set(["name", "bookings", "packages", "joined"]);

export type StudentRow = {
  id: string;
  email: string | null;
  name: string;
  disabledAt: Date | null;
  createdAt: Date;
  _count: { bookings: number; packages: number };
  teacherStudents: { teacher: { id: string; name: string } }[];
};

type Filters = { q: string; teacherId: string };

function filtersFromParams(params: { q?: string; teacherId?: string }): Filters {
  return { q: params.q ?? "", teacherId: params.teacherId ?? "" };
}

function sortFromParams(params: { sort?: string; dir?: string }): SortState {
  return { key: params.sort ?? "joined", dir: params.dir === "asc" ? "asc" : "desc" };
}

export function StudentsTable({
  initialStudents,
  teachers,
  params,
}: {
  initialStudents: StudentRow[];
  teachers: { id: string; name: string }[];
  params: { q?: string; teacherId?: string; sort?: string; dir?: string };
}) {
  const t = useT();
  const formRef = useRef<HTMLFormElement>(null);
  const scheduleSubmit = useDebouncedSubmit(0);

  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(params));
  const [sort, setSort] = useState<SortState>(() => sortFromParams(params));

  useEffect(() => {
    setFilters(filtersFromParams(params));
    setSort(sortFromParams(params));
  }, [params]);

  const visibleStudents = useMemo(
    () => initialStudents.filter((row) => matchesStudentFilters(row, filters)),
    [initialStudents, filters],
  );

  function handleSortChange(next: SortState) {
    setSort(next);
    if (SERVER_SORTABLE.has(next.key)) scheduleSubmit(formRef.current);
  }

  const columns = useMemo<AdminColumnDef<StudentRow>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.name,
        header: t("web.admin.students.colStudent"),
        meta: { label: t("web.admin.students.colStudent"), sortable: true },
        cell: ({ row }) => (
          <RowLink href={`/admin/students/${row.original.id}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium">{row.original.name}</span>
              {row.original.disabledAt && (
                <Badge variant="destructive">{t("web.admin.disabledBadge")}</Badge>
              )}
            </div>
            <div className="text-muted-foreground text-xs">
              {row.original.email ?? t("web.admin.students.noEmail")}
            </div>
          </RowLink>
        ),
      },
      {
        id: "teachers",
        header: t("web.admin.students.colTeachers"),
        meta: { label: t("web.admin.students.colTeachers"), className: "text-xs" },
        cell: ({ row }) =>
          row.original.teacherStudents.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            row.original.teacherStudents.map((ts) => ts.teacher.name).join(", ")
          ),
      },
      {
        id: "bookings",
        accessorFn: (row) => row._count.bookings,
        header: t("web.admin.students.colBookings"),
        meta: { label: t("web.admin.students.colBookings"), sortable: true },
        cell: ({ row }) => row.original._count.bookings,
      },
      {
        id: "packages",
        accessorFn: (row) => row._count.packages,
        header: t("web.admin.students.colPackages"),
        meta: { label: t("web.admin.students.colPackages"), sortable: true },
        cell: ({ row }) => row.original._count.packages,
      },
      {
        id: "joined",
        accessorFn: (row) => new Date(row.createdAt).getTime(),
        header: t("web.admin.students.colJoined"),
        meta: {
          label: t("web.admin.students.colJoined"),
          sortable: true,
          className: "text-right text-xs text-muted-foreground",
        },
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
      },
    ],
    [t],
  );

  return (
    <>
      <FilterBar ref={formRef} columns={3} resetHref="/admin/students">
        <input type="hidden" name="sort" value={sort.key} />
        <input type="hidden" name="dir" value={sort.dir} />
        <FilterField label={t("web.admin.searchNameEmail")} span={2}>
          <DebouncedSearchInput
            name="q"
            defaultValue={filters.q}
            placeholder={t("web.admin.teachers.searchPlaceholder")}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          />
        </FilterField>
        <FilterSelect
          label={t("web.admin.teacherLabel")}
          name="teacherId"
          value={filters.teacherId}
          onValueChange={(v) => setFilters((f) => ({ ...f, teacherId: v }))}
          options={[
            { value: "", label: t("web.admin.all") },
            ...teachers.map((teacher) => ({ value: teacher.id, label: teacher.name })),
          ]}
        />
      </FilterBar>

      {visibleStudents.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("web.admin.noResults")}</p>
      ) : (
        <TableShell>
          <DataTable
            columns={columns}
            data={visibleStudents}
            sort={sort}
            onSortChange={handleSortChange}
            getRowId={(row) => row.id}
          />
        </TableShell>
      )}
    </>
  );
}
