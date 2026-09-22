"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DataTable, type AdminColumnDef, type SortState } from "@/components/ui/data-table";
import { DebouncedSearchInput } from "@/components/ui/debounced-search";
import { FilterBar, FilterField, FilterSelect } from "@/components/ui/filter-bar";
import { RowLink, TableShell } from "@/components/ui/table";
import { matchesPackageFilters } from "@/lib/admin-filters";
import { formatMinorUnits } from "@/lib/money";
import { useDebouncedSubmit } from "@/lib/use-debounced-submit";
import { useT } from "@/components/locale-provider";
import type { PackageStatus } from "@prisma/client";

const SERVER_SORTABLE = new Set(["created", "classes", "expires", "status", "paid"]);

export type PackageRow = {
  id: string;
  classesTotal: number;
  classesUsed: number;
  pricePaidMinorUnits: number;
  expiresAt: Date | null;
  status: PackageStatus;
  createdAt: Date;
  teacher: { name: string };
  student: { name: string };
  template: { name: string } | null;
};

type Filters = { q: string; status: string };

function filtersFromParams(params: { q?: string; status?: string }): Filters {
  return { q: params.q ?? "", status: params.status ?? "" };
}

function sortFromParams(params: { sort?: string; dir?: string }): SortState {
  return { key: params.sort ?? "created", dir: params.dir === "asc" ? "asc" : "desc" };
}

export function PackagesTable({
  initialPackages,
  statuses,
  params,
}: {
  initialPackages: PackageRow[];
  statuses: PackageStatus[];
  params: { q?: string; status?: string; sort?: string; dir?: string };
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

  const visiblePackages = useMemo(
    () => initialPackages.filter((row) => matchesPackageFilters(row, filters)),
    [initialPackages, filters],
  );

  function handleSortChange(next: SortState) {
    setSort(next);
    if (SERVER_SORTABLE.has(next.key)) scheduleSubmit(formRef.current);
  }

  const columns = useMemo<AdminColumnDef<PackageRow>[]>(
    () => [
      {
        id: "created",
        accessorFn: (row) => new Date(row.createdAt).getTime(),
        header: t("web.admin.common.created"),
        meta: {
          label: t("web.admin.common.created"),
          sortable: true,
          className: "text-xs text-muted-foreground",
        },
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
      },
      {
        id: "teacher",
        header: t("web.admin.common.teacher"),
        meta: { label: t("web.admin.common.teacher") },
        cell: ({ row }) => row.original.teacher.name,
      },
      {
        id: "student",
        header: t("web.admin.common.student"),
        meta: { label: t("web.admin.common.student") },
        cell: ({ row }) => row.original.student.name,
      },
      {
        id: "template",
        header: t("web.admin.packages.template"),
        meta: { label: t("web.admin.packages.template") },
        cell: ({ row }) => (
          <RowLink href={`/admin/packages/${row.original.id}`}>
            {row.original.template?.name ?? "—"}
          </RowLink>
        ),
      },
      {
        id: "classes",
        accessorFn: (row) => row.classesTotal,
        header: t("web.admin.packages.classes"),
        meta: { label: t("web.admin.packages.classes"), sortable: true },
        cell: ({ row }) => `${row.original.classesUsed}/${row.original.classesTotal}`,
      },
      {
        id: "expires",
        accessorFn: (row) => (row.expiresAt ? new Date(row.expiresAt).getTime() : null),
        header: t("web.admin.packages.expires"),
        meta: {
          label: t("web.admin.packages.expires"),
          sortable: true,
          className: "text-xs text-muted-foreground",
        },
        cell: ({ row }) =>
          row.original.expiresAt ? new Date(row.original.expiresAt).toLocaleDateString() : "—",
      },
      {
        id: "status",
        accessorFn: (row) => row.status,
        header: t("web.admin.common.status"),
        meta: { label: t("web.admin.common.status"), sortable: true },
        cell: ({ row }) => row.original.status,
      },
      {
        id: "paid",
        accessorFn: (row) => row.pricePaidMinorUnits,
        header: t("web.admin.common.paid"),
        meta: {
          label: t("web.admin.common.paid"),
          sortable: true,
          className: "text-right font-medium",
        },
        cell: ({ row }) => formatMinorUnits(row.original.pricePaidMinorUnits),
      },
    ],
    [t],
  );

  return (
    <>
      <FilterBar ref={formRef} columns={4} resetHref="/admin/packages">
        <input type="hidden" name="sort" value={sort.key} />
        <input type="hidden" name="dir" value={sort.dir} />
        <FilterField label={t("web.admin.packages.searchLabel")} span={2}>
          <DebouncedSearchInput
            name="q"
            defaultValue={filters.q}
            placeholder={t("web.admin.common.nameOrEmail")}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          />
        </FilterField>
        <FilterSelect
          label={t("web.admin.common.status")}
          name="status"
          value={filters.status}
          onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}
          options={[
            { value: "", label: t("web.admin.common.all") },
            ...statuses.map((s) => ({ value: s, label: s })),
          ]}
        />
      </FilterBar>

      {visiblePackages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("web.admin.packages.noneMatched")}</p>
      ) : (
        <TableShell>
          <DataTable
            columns={columns}
            data={visiblePackages}
            sort={sort}
            onSortChange={handleSortChange}
            getRowId={(row) => row.id}
          />
        </TableShell>
      )}
    </>
  );
}
