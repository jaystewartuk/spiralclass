"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable, type AdminColumnDef, type SortState } from "@/components/ui/data-table";
import { DebouncedSearchInput } from "@/components/ui/debounced-search";
import { FilterBar, FilterField, FilterSelect } from "@/components/ui/filter-bar";
import { TableShell } from "@/components/ui/table";
import { matchesNotificationFilters } from "@/lib/admin-filters";
import { useDebouncedSubmit } from "@/lib/use-debounced-submit";
import { useT } from "@/components/locale-provider";
import { RetryButton } from "./retry-button";
import type { NotificationChannel, NotificationStatus } from "@prisma/client";

const SERVER_SORTABLE = new Set(["when", "template", "channel", "status"]);

export type NotificationRow = {
  id: string;
  templateName: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  languageCode: string | null;
  error: string | null;
  providerMessageId: string | null;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  recipientType: string;
  recipientId: string;
  recipient: { name: string; email: string | null } | null;
  resendUrl: string | null;
  suppressed: string | null;
};

type Filters = { q: string; status: string; channel: string };

function filtersFromParams(params: { q?: string; status?: string; channel?: string }): Filters {
  return { q: params.q ?? "", status: params.status ?? "", channel: params.channel ?? "" };
}

function sortFromParams(params: { sort?: string; dir?: string }): SortState {
  return { key: params.sort ?? "when", dir: params.dir === "asc" ? "asc" : "desc" };
}

export function NotificationsTable({
  initialNotifications,
  statuses,
  channels,
  params,
}: {
  initialNotifications: NotificationRow[];
  statuses: NotificationStatus[];
  channels: NotificationChannel[];
  params: { q?: string; status?: string; channel?: string; sort?: string; dir?: string };
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

  const visibleNotifications = useMemo(
    () => initialNotifications.filter((row) => matchesNotificationFilters(row, filters)),
    [initialNotifications, filters],
  );

  function handleSortChange(next: SortState) {
    setSort(next);
    if (SERVER_SORTABLE.has(next.key)) scheduleSubmit(formRef.current);
  }

  const columns = useMemo<AdminColumnDef<NotificationRow>[]>(
    () => [
      {
        id: "when",
        accessorFn: (row) => new Date(row.createdAt).getTime(),
        header: t("web.admin.notifications.colWhen"),
        meta: {
          label: t("web.admin.notifications.colWhen"),
          sortable: true,
          className: "text-xs text-muted-foreground",
        },
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleString(),
      },
      {
        id: "recipient",
        header: t("web.admin.notifications.colRecipient"),
        meta: { label: t("web.admin.notifications.colRecipient") },
        cell: ({ row }) => (
          <>
            <div className="font-medium">{row.original.recipient?.name ?? "—"}</div>
            <div className="text-xs text-muted-foreground">
              {row.original.recipientType}
              {row.original.recipient?.email ? ` · ${row.original.recipient.email}` : ""}
            </div>
          </>
        ),
      },
      {
        id: "template",
        accessorFn: (row) => row.templateName,
        header: t("web.admin.notifications.colTemplate"),
        meta: { label: t("web.admin.notifications.colTemplate"), sortable: true },
        cell: ({ row }) => row.original.templateName,
      },
      {
        id: "channel",
        accessorFn: (row) => row.channel,
        header: t("web.admin.notifications.channel"),
        meta: { label: t("web.admin.notifications.channel"), sortable: true },
        cell: ({ row }) => row.original.channel,
      },
      {
        id: "lang",
        header: t("web.admin.notifications.colLang"),
        meta: { label: t("web.admin.notifications.colLang") },
        cell: ({ row }) => row.original.languageCode ?? "—",
      },
      {
        id: "status",
        accessorFn: (row) => row.status,
        header: t("web.admin.disputes.colStatus"),
        meta: { label: t("web.admin.disputes.colStatus"), sortable: true },
        cell: ({ row }) =>
          row.original.suppressed ? (
            <Badge variant="warning">{t("web.admin.notifications.suppressedBadge")}</Badge>
          ) : (
            row.original.status
          ),
      },
      {
        id: "error",
        header: t("web.admin.notifications.colError"),
        meta: { label: t("web.admin.notifications.colError") },
        cell: ({ row }) => (
          <span
            className={
              row.original.suppressed ? "text-xs text-warning" : "text-xs text-destructive"
            }
          >
            {row.original.suppressed ?? row.original.error ?? ""}
          </span>
        ),
      },
      {
        id: "actions",
        header: t("web.admin.notifications.colActions"),
        meta: { label: t("web.admin.notifications.colActions"), className: "text-right" },
        cell: ({ row }) => {
          const n = row.original;
          return (
            <div className="flex items-center justify-end gap-2">
              {n.resendUrl ? (
                <a
                  href={n.resendUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground underline hover:text-foreground"
                >
                  {t("web.admin.notifications.resendLink")}
                </a>
              ) : null}
              {n.status === "failed" || n.status === "queued" ? (
                <RetryButton notificationId={n.id} />
              ) : null}
            </div>
          );
        },
      },
    ],
    [t],
  );

  return (
    <>
      <FilterBar ref={formRef} columns={4} resetHref="/admin/notifications">
        <input type="hidden" name="sort" value={sort.key} />
        <input type="hidden" name="dir" value={sort.dir} />
        <FilterField label={t("web.admin.notifications.searchTemplate")} span={2}>
          <DebouncedSearchInput
            name="q"
            defaultValue={filters.q}
            placeholder={t("web.admin.notifications.searchPlaceholder")}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          />
        </FilterField>
        <FilterSelect
          label={t("web.admin.disputes.colStatus")}
          name="status"
          value={filters.status}
          onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}
          options={[
            { value: "", label: t("web.admin.notifications.all") },
            ...statuses.map((s) => ({ value: s, label: s })),
          ]}
        />
        <FilterSelect
          label={t("web.admin.notifications.channel")}
          name="channel"
          value={filters.channel}
          onValueChange={(v) => setFilters((f) => ({ ...f, channel: v }))}
          options={[
            { value: "", label: t("web.admin.notifications.all") },
            ...channels.map((c) => ({ value: c, label: c })),
          ]}
        />
      </FilterBar>

      {visibleNotifications.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("web.admin.notifications.noneMatched")}</p>
      ) : (
        <TableShell>
          <DataTable
            columns={columns}
            data={visibleNotifications}
            sort={sort}
            onSortChange={handleSortChange}
            getRowId={(row) => row.id}
          />
        </TableShell>
      )}
    </>
  );
}
