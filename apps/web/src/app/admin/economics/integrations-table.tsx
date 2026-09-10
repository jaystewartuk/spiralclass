"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type AdminColumnDef, type SortState } from "@/components/ui/data-table";
import { TableShell } from "@/components/ui/table";
import { useT } from "@/components/locale-provider";
import {
  toggleIntegrationActiveAction,
  deleteIntegrationAction,
  type AdminEconomicsActionState,
} from "@/app/actions/admin-economics";
import { isIntegrationCategory, DEFAULT_INTEGRATION_CATEGORY } from "@spiralclass/shared";
import type { IntegrationRow } from "./integrations-panel";

function ToggleActiveButton({ id, active }: { id: string; active: boolean }) {
  const t = useT();
  const [, action, pending] = useActionState<AdminEconomicsActionState, FormData>(
    toggleIntegrationActiveAction,
    undefined,
  );
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={(!active).toString()} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {active
          ? t("web.admin.economics.integrations.deactivate")
          : t("web.admin.economics.integrations.activate")}
      </Button>
    </form>
  );
}

function DeleteIntegrationButton({ id }: { id: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<AdminEconomicsActionState, FormData>(
    deleteIntegrationAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) setOpen(false);
  }, [state?.ok]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button type="button" variant="outline" size="sm">
          {t("common.delete")}
        </Button>
      }
      title={t("web.admin.economics.integrations.deleteTitle")}
      description={t("web.admin.economics.integrations.deleteConfirm")}
      footer={() => (
        <Button
          type="submit"
          form={`delete-integration-${id}`}
          variant="destructive"
          size="sm"
          disabled={pending}
        >
          {t("common.delete")}
        </Button>
      )}
    >
      <form id={`delete-integration-${id}`} action={action}>
        <input type="hidden" name="id" value={id} />
        {state?.error && <p className="text-destructive text-sm">{state.error}</p>}
      </form>
    </ConfirmDialog>
  );
}

export function IntegrationsTable({
  rows,
  onEdit,
}: {
  rows: IntegrationRow[];
  onEdit: (row: IntegrationRow) => void;
}) {
  const t = useT();
  const [sort, setSort] = useState<SortState>({ key: "name", dir: "asc" });

  const columns = useMemo<AdminColumnDef<IntegrationRow>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.name,
        header: t("web.admin.economics.integrations.colName"),
        meta: { label: t("web.admin.economics.integrations.colName"), sortable: true },
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.name}</div>
            <div className="text-muted-foreground text-xs">{row.original.key}</div>
          </div>
        ),
      },
      {
        id: "category",
        accessorFn: (row) => row.category,
        header: t("web.admin.economics.integrations.category"),
        meta: { label: t("web.admin.economics.integrations.category"), sortable: true },
        cell: ({ row }) => (
          <Badge variant="info">
            {t(
              `economics.category.${
                isIntegrationCategory(row.original.category)
                  ? row.original.category
                  : DEFAULT_INTEGRATION_CATEGORY
              }`,
            )}
          </Badge>
        ),
      },
      {
        id: "currency",
        accessorFn: (row) => row.currency,
        header: t("web.admin.economics.integrations.currency"),
        meta: { label: t("web.admin.economics.integrations.currency"), sortable: true },
        cell: ({ row }) => row.original.currency,
      },
      {
        id: "active",
        accessorFn: (row) => (row.active ? 1 : 0),
        header: t("web.admin.economics.integrations.status"),
        meta: { label: t("web.admin.economics.integrations.status"), sortable: true },
        cell: ({ row }) =>
          row.original.active ? (
            <Badge variant="success">{t("web.admin.economics.integrations.active")}</Badge>
          ) : (
            <Badge variant="outline">{t("web.admin.economics.integrations.deactivate")}</Badge>
          ),
      },
      {
        id: "actions",
        header: t("web.admin.staff.actions"),
        meta: { label: t("web.admin.staff.actions") },
        cell: ({ row }) => (
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onEdit(row.original)}>
              {t("common.edit")}
            </Button>
            <ToggleActiveButton id={row.original.id} active={row.original.active} />
            <DeleteIntegrationButton id={row.original.id} />
          </div>
        ),
      },
    ],
    [t, onEdit],
  );

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("web.admin.economics.integrations.noEntries")}
      </p>
    );
  }

  return (
    <TableShell>
      <DataTable
        columns={columns}
        data={rows}
        sort={sort}
        onSortChange={setSort}
        getRowId={(row) => row.id}
      />
    </TableShell>
  );
}
