"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DataTable, type AdminColumnDef, type SortState } from "@/components/ui/data-table";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { TableShell } from "@/components/ui/table";
import { matchesDisputeFilters } from "@/lib/admin-filters";
import { formatMinorUnits } from "@/lib/money";
import { useDebouncedSubmit } from "@/lib/use-debounced-submit";
import { useT } from "@/components/locale-provider";
import type { DisputeStatus } from "@prisma/client";

const SERVER_SORTABLE = new Set(["opened", "due", "status", "amount"]);

export type DisputeRow = {
  id: string;
  status: DisputeStatus;
  isFinal: boolean;
  reason: string;
  amountMinorUnits: number;
  createdAt: Date;
  evidenceDueBy: Date | null;
  payment: {
    package: {
      teacher: { id: string; name: string };
      student: { name: string };
    };
  } | null;
};

type Filters = { status: string };

function filtersFromParams(params: { status?: string }): Filters {
  return { status: params.status ?? "" };
}

function sortFromParams(params: { sort?: string; dir?: string }): SortState {
  return { key: params.sort ?? "opened", dir: params.dir === "asc" ? "asc" : "desc" };
}

export function DisputesTable({
  initialDisputes,
  statuses,
  params,
}: {
  initialDisputes: DisputeRow[];
  statuses: DisputeStatus[];
  params: { status?: string; sort?: string; dir?: string };
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

  const visibleDisputes = useMemo(
    () => initialDisputes.filter((row) => matchesDisputeFilters(row, filters)),
    [initialDisputes, filters],
  );

  function handleSortChange(next: SortState) {
    setSort(next);
    if (SERVER_SORTABLE.has(next.key)) scheduleSubmit(formRef.current);
  }

  const columns = useMemo<AdminColumnDef<DisputeRow>[]>(
    () => [
      {
        id: "opened",
        accessorFn: (row) => new Date(row.createdAt).getTime(),
        header: t("web.admin.disputes.colOpened"),
        meta: {
          label: t("web.admin.disputes.colOpened"),
          sortable: true,
          className: "text-xs text-muted-foreground",
        },
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleString(),
      },
      {
        id: "teacher",
        header: t("web.admin.disputes.colTeacher"),
        meta: { label: t("web.admin.disputes.colTeacher") },
        cell: ({ row }) =>
          row.original.payment ? (
            <Link
              href={`/admin/teachers/${row.original.payment.package.teacher.id}`}
              className="hover:underline"
            >
              {row.original.payment.package.teacher.name}
            </Link>
          ) : (
            <span className="text-muted-foreground text-xs">
              {t("web.admin.disputes.unmatched")}
            </span>
          ),
      },
      {
        id: "student",
        header: t("web.admin.disputes.colStudent"),
        meta: { label: t("web.admin.disputes.colStudent") },
        cell: ({ row }) => row.original.payment?.package.student.name ?? "—",
      },
      {
        id: "reason",
        header: t("web.admin.disputes.colReason"),
        meta: { label: t("web.admin.disputes.colReason"), className: "text-xs" },
        cell: ({ row }) => row.original.reason,
      },
      {
        id: "status",
        accessorFn: (row) => row.status,
        header: t("web.admin.disputes.colStatus"),
        meta: { label: t("web.admin.disputes.colStatus"), sortable: true },
        cell: ({ row }) => {
          const d = row.original;
          const label = d.status.replace(/_/g, " ");
          if (d.status === "needs_response") return <Badge variant="destructive">{label}</Badge>;
          if (d.isFinal) return <span className="text-muted-foreground text-xs">{label}</span>;
          return <Badge variant="warning">{label}</Badge>;
        },
      },
      {
        id: "due",
        accessorFn: (row) => (row.evidenceDueBy ? new Date(row.evidenceDueBy).getTime() : null),
        header: t("web.admin.disputes.colDueBy"),
        meta: {
          label: t("web.admin.disputes.colDueBy"),
          sortable: true,
          className: "text-xs text-muted-foreground",
        },
        cell: ({ row }) =>
          row.original.evidenceDueBy ? new Date(row.original.evidenceDueBy).toLocaleString() : "—",
      },
      {
        id: "amount",
        accessorFn: (row) => row.amountMinorUnits,
        header: t("web.admin.disputes.colAmount"),
        meta: {
          label: t("web.admin.disputes.colAmount"),
          sortable: true,
          className: "text-right font-medium",
        },
        cell: ({ row }) => formatMinorUnits(row.original.amountMinorUnits),
      },
    ],
    [t],
  );

  return (
    <>
      <FilterBar ref={formRef} columns={2} resetHref="/admin/disputes">
        <input type="hidden" name="sort" value={sort.key} />
        <input type="hidden" name="dir" value={sort.dir} />
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

      {visibleDisputes.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("web.admin.disputes.none.pre")} <code>{t("web.admin.disputes.webhookEvent")}</code>{" "}
          {t("web.admin.disputes.none.mid")}{" "}
          <Link href="/admin/integrations" className="underline">
            {t("web.admin.disputes.integrations")}
          </Link>
          {t("web.admin.disputes.none.post")}
        </p>
      ) : (
        <TableShell>
          <DataTable
            columns={columns}
            data={visibleDisputes}
            sort={sort}
            onSortChange={handleSortChange}
            getRowId={(row) => row.id}
          />
        </TableShell>
      )}
    </>
  );
}
