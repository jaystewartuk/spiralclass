"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DataTable, type AdminColumnDef, type SortState } from "@/components/ui/data-table";
import { DebouncedSearchInput } from "@/components/ui/debounced-search";
import { FilterBar, FilterField, FilterSelect } from "@/components/ui/filter-bar";
import { TableShell } from "@/components/ui/table";
import { matchesAuditFilters } from "@/lib/admin-filters";
import { useDebouncedSubmit } from "@/lib/use-debounced-submit";
import { useT } from "@/components/locale-provider";
import type { OverrideTargetType } from "@prisma/client";

const SERVER_SORTABLE = new Set(["when", "action"]);

export type AuditRow = {
  id: string;
  action: string;
  targetType: OverrideTargetType;
  targetId: string;
  reason: string;
  createdAt: Date;
  teacherId: string | null;
  teacher: { name: string; email: string } | null;
};

type Filters = { q: string; targetType: string; teacherId: string };

function filtersFromParams(params: {
  q?: string;
  targetType?: string;
  teacherId?: string;
}): Filters {
  return {
    q: params.q ?? "",
    targetType: params.targetType ?? "",
    teacherId: params.teacherId ?? "",
  };
}

function sortFromParams(params: { sort?: string; dir?: string }): SortState {
  return { key: params.sort ?? "when", dir: params.dir === "asc" ? "asc" : "desc" };
}

export function AuditTable({
  initialOverrides,
  targetTypes,
  teachers,
  params,
}: {
  initialOverrides: AuditRow[];
  targetTypes: OverrideTargetType[];
  teachers: { id: string; name: string }[];
  params: { q?: string; targetType?: string; teacherId?: string; sort?: string; dir?: string };
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

  const visibleOverrides = useMemo(
    () => initialOverrides.filter((row) => matchesAuditFilters(row, filters)),
    [initialOverrides, filters],
  );

  function handleSortChange(next: SortState) {
    setSort(next);
    if (SERVER_SORTABLE.has(next.key)) scheduleSubmit(formRef.current);
  }

  const columns = useMemo<AdminColumnDef<AuditRow>[]>(
    () => [
      {
        id: "when",
        accessorFn: (row) => new Date(row.createdAt).getTime(),
        header: t("web.admin.audit.when"),
        meta: {
          label: t("web.admin.audit.when"),
          sortable: true,
          className: "text-xs text-muted-foreground",
        },
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleString(),
      },
      {
        id: "teacher",
        header: t("web.admin.audit.teacher"),
        meta: { label: t("web.admin.audit.teacher") },
        cell: ({ row }) =>
          row.original.teacher ? (
            <>
              <div className="font-medium">{row.original.teacher.name}</div>
              <div className="text-muted-foreground text-xs">{row.original.teacher.email}</div>
            </>
          ) : (
            <span className="text-muted-foreground text-xs">{t("web.admin.audit.platform")}</span>
          ),
      },
      {
        id: "action",
        accessorFn: (row) => row.action,
        header: t("web.admin.audit.action"),
        meta: {
          label: t("web.admin.audit.action"),
          sortable: true,
          className: "font-mono text-xs",
        },
        cell: ({ row }) => row.original.action,
      },
      {
        id: "target",
        header: t("web.admin.audit.target"),
        meta: { label: t("web.admin.audit.target"), className: "text-xs" },
        cell: ({ row }) => (
          <>
            <div>{row.original.targetType}</div>
            <div className="text-muted-foreground break-all">{row.original.targetId}</div>
          </>
        ),
      },
      {
        id: "reason",
        header: t("web.admin.audit.reason"),
        meta: { label: t("web.admin.audit.reason"), className: "max-w-md text-xs" },
        cell: ({ row }) => row.original.reason,
      },
    ],
    [t],
  );

  return (
    <>
      <FilterBar ref={formRef} columns={4} resetHref="/admin/audit">
        <input type="hidden" name="sort" value={sort.key} />
        <input type="hidden" name="dir" value={sort.dir} />
        <FilterField label={t("web.admin.audit.searchLabel")} span={2}>
          <DebouncedSearchInput
            name="q"
            defaultValue={filters.q}
            placeholder={t("web.admin.audit.searchPlaceholder")}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          />
        </FilterField>
        <FilterSelect
          label={t("web.admin.audit.targetTypeLabel")}
          name="targetType"
          value={filters.targetType}
          onValueChange={(v) => setFilters((f) => ({ ...f, targetType: v }))}
          options={[
            { value: "", label: t("web.admin.audit.all") },
            ...targetTypes.map((tt) => ({ value: tt, label: tt })),
          ]}
        />
        <FilterSelect
          label={t("web.admin.audit.teacherLabel")}
          name="teacherId"
          value={filters.teacherId}
          onValueChange={(v) => setFilters((f) => ({ ...f, teacherId: v }))}
          options={[
            { value: "", label: t("web.admin.audit.all") },
            { value: "platform", label: t("web.admin.audit.platformNoTeacher") },
            ...teachers.map((teacher) => ({ value: teacher.id, label: teacher.name })),
          ]}
        />
      </FilterBar>

      {visibleOverrides.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("web.admin.audit.noneMatched")}</p>
      ) : (
        <TableShell>
          <DataTable
            columns={columns}
            data={visibleOverrides}
            sort={sort}
            onSortChange={handleSortChange}
            getRowId={(row) => row.id}
            getRowClassName={() => "align-top"}
          />
        </TableShell>
      )}
    </>
  );
}
