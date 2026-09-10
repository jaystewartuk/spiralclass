"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DataTable, type AdminColumnDef, type SortState } from "@/components/ui/data-table";
import { DebouncedSearchInput } from "@/components/ui/debounced-search";
import { FilterBar, FilterField, FilterSelect } from "@/components/ui/filter-bar";
import { TableShell } from "@/components/ui/table";
import { matchesPaymentFilters, PAYMENT_STATUSES } from "@/lib/admin-filters";
import { formatMinorUnits } from "@/lib/money";
import { stripePaymentIntentUrl } from "@/lib/external-links";
import { useDebouncedSubmit } from "@/lib/use-debounced-submit";
import { useT } from "@/components/locale-provider";
import { RefundButton } from "./refund-form";
import type { PaymentStatus } from "@prisma/client";

const SERVER_SORTABLE = new Set(["date", "status", "amount"]);

export type PaymentRow = {
  id: string;
  status: PaymentStatus;
  provider: string;
  providerPaymentId: string | null;
  amountMinorUnits: number;
  createdAt: Date;
  package: {
    id: string;
    template: { name: string } | null;
    student: { name: string; email: string | null };
    teacher: { id: string; name: string; email: string };
  };
};

type Filters = { q: string; status: string; from: string; to: string };

function filtersFromParams(params: {
  q?: string;
  status?: string;
  from?: string;
  to?: string;
}): Filters {
  return {
    q: params.q ?? "",
    status: params.status ?? "",
    from: params.from ?? "",
    to: params.to ?? "",
  };
}

function sortFromParams(params: { sort?: string; dir?: string }): SortState {
  return { key: params.sort ?? "date", dir: params.dir === "asc" ? "asc" : "desc" };
}

export function PaymentsTable({
  initialPayments,
  statusLabels,
  canRefund,
  params,
}: {
  initialPayments: PaymentRow[];
  statusLabels: Record<PaymentStatus, string>;
  canRefund: boolean;
  params: { q?: string; status?: string; from?: string; to?: string; sort?: string; dir?: string };
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

  const visiblePayments = useMemo(
    () => initialPayments.filter((row) => matchesPaymentFilters(row, filters)),
    [initialPayments, filters],
  );

  function handleSortChange(next: SortState) {
    setSort(next);
    if (SERVER_SORTABLE.has(next.key)) scheduleSubmit(formRef.current);
  }

  const columns = useMemo<AdminColumnDef<PaymentRow>[]>(
    () => [
      {
        id: "date",
        accessorFn: (row) => new Date(row.createdAt).getTime(),
        header: t("web.admin.common.date"),
        meta: {
          label: t("web.admin.common.date"),
          sortable: true,
          className: "text-xs text-muted-foreground",
        },
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleString(),
      },
      {
        id: "teacher",
        header: t("web.admin.common.teacher"),
        meta: { label: t("web.admin.common.teacher") },
        cell: ({ row }) => (
          <Link
            href={`/admin/teachers/${row.original.package.teacher.id}`}
            className="hover:underline"
          >
            {row.original.package.teacher.name}
          </Link>
        ),
      },
      {
        id: "student",
        header: t("web.admin.common.student"),
        meta: { label: t("web.admin.common.student") },
        cell: ({ row }) => row.original.package.student.name,
      },
      {
        id: "package",
        header: t("web.admin.payments.package"),
        meta: { label: t("web.admin.payments.package") },
        cell: ({ row }) => row.original.package.template?.name ?? "—",
      },
      {
        id: "status",
        accessorFn: (row) => row.status,
        header: t("web.admin.common.status"),
        meta: { label: t("web.admin.common.status"), sortable: true },
        cell: ({ row }) => <StatusBadge status={row.original.status} labels={statusLabels} />,
      },
      {
        id: "amount",
        accessorFn: (row) => row.amountMinorUnits,
        header: t("web.admin.common.amount"),
        meta: {
          label: t("web.admin.common.amount"),
          sortable: true,
          className: "text-right font-medium",
        },
        cell: ({ row }) => formatMinorUnits(row.original.amountMinorUnits),
      },
      {
        id: "actions",
        header: t("web.admin.common.actions"),
        meta: { label: t("web.admin.common.actions"), className: "text-right" },
        cell: ({ row }) => {
          const p = row.original;
          const isStripe = p.provider === "stripe";
          const stripeUrl = isStripe ? stripePaymentIntentUrl(p.providerPaymentId) : null;
          return (
            <div className="flex items-center justify-end gap-2">
              {stripeUrl ? (
                <a
                  href={stripeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground text-xs underline"
                >
                  {t("web.admin.common.stripe")} ↗
                </a>
              ) : null}
              {p.status === "paid" && isStripe && p.providerPaymentId && canRefund ? (
                <RefundButton paymentId={p.id} />
              ) : null}
            </div>
          );
        },
      },
    ],
    [t, statusLabels, canRefund],
  );

  return (
    <>
      <FilterBar ref={formRef} columns={5} resetHref="/admin/payments">
        <input type="hidden" name="sort" value={sort.key} />
        <input type="hidden" name="dir" value={sort.dir} />
        <FilterField label={t("web.admin.payments.searchLabel")} span={2}>
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
            ...PAYMENT_STATUSES.map((s) => ({ value: s, label: s })),
          ]}
        />
        <FilterField label={t("web.admin.common.from")}>
          <DebouncedSearchInput
            type="date"
            name="from"
            defaultValue={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          />
        </FilterField>
        <FilterField label={t("web.admin.common.to")}>
          <DebouncedSearchInput
            type="date"
            name="to"
            defaultValue={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          />
        </FilterField>
      </FilterBar>

      {visiblePayments.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("web.admin.payments.noneMatched")}</p>
      ) : (
        <TableShell>
          <DataTable
            columns={columns}
            data={visiblePayments}
            sort={sort}
            onSortChange={handleSortChange}
            getRowId={(row) => row.id}
          />
        </TableShell>
      )}
    </>
  );
}

function StatusBadge({ status, labels }: { status: string; labels: Record<string, string> }) {
  const variant: Record<string, "warning" | "success" | "destructive" | "secondary"> = {
    pending: "warning",
    paid: "success",
    failed: "destructive",
    refunded: "secondary",
  };
  return <Badge variant={variant[status] ?? "secondary"}>{labels[status] ?? status}</Badge>;
}
