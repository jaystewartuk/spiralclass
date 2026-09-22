"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable, type AdminColumnDef, type SortState } from "@/components/ui/data-table";
import { TableShell } from "@/components/ui/table";
import { useT } from "@/components/locale-provider";
import { InviteForm, RoleSelect, ToggleDisabledButton } from "./invite-form";
import type { AdminRole } from "@prisma/client";

export type StaffRow = {
  id: string;
  email: string;
  role: AdminRole;
  disabledAt: Date | null;
  createdAt: Date;
  createdBy: { email: string } | null;
};

export function StaffTable({
  admins,
  actorId,
  isBootstrap,
}: {
  admins: StaffRow[];
  actorId: string;
  isBootstrap: boolean;
}) {
  const t = useT();
  // No server-side sort sync here — the staff roster loads in full (no
  // pagination), so sorting is purely client-side and instant, same as every
  // other column on this page.
  const [sort, setSort] = useState<SortState>({ key: "created", dir: "desc" });

  const columns: AdminColumnDef<StaffRow>[] = [
    {
      id: "email",
      accessorFn: (row) => row.email,
      header: t("common.email"),
      meta: { label: t("common.email"), sortable: true, className: "font-medium" },
      cell: ({ row }) => {
        const isSelf = !isBootstrap && row.original.id === actorId;
        return (
          <>
            {row.original.email}
            {isSelf ? (
              <Badge variant="info" className="ml-2">
                {t("web.admin.staff.you")}
              </Badge>
            ) : null}
          </>
        );
      },
    },
    {
      id: "role",
      accessorFn: (row) => row.role,
      header: t("web.admin.staff.role"),
      meta: { label: t("web.admin.staff.role"), sortable: true },
      cell: ({ row }) => {
        const isSelf = !isBootstrap && row.original.id === actorId;
        return (
          <RoleSelect
            adminId={row.original.id}
            currentRole={row.original.role}
            selfDisabled={isSelf}
          />
        );
      },
    },
    {
      id: "status",
      accessorFn: (row) => (row.disabledAt ? 1 : 0),
      header: t("web.admin.staff.status"),
      meta: { label: t("web.admin.staff.status"), sortable: true },
      cell: ({ row }) =>
        row.original.disabledAt ? (
          <Badge variant="destructive">{t("web.admin.staff.disabled")}</Badge>
        ) : (
          <Badge variant="success">{t("web.admin.staff.active")}</Badge>
        ),
    },
    {
      id: "invitedBy",
      header: t("web.admin.staff.invitedBy"),
      meta: { label: t("web.admin.staff.invitedBy"), className: "text-xs text-muted-foreground" },
      cell: ({ row }) => row.original.createdBy?.email ?? "—",
    },
    {
      id: "created",
      accessorFn: (row) => new Date(row.createdAt).getTime(),
      header: t("web.admin.staff.created"),
      meta: {
        label: t("web.admin.staff.created"),
        sortable: true,
        className: "text-xs text-muted-foreground",
      },
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
    },
    {
      id: "actions",
      header: t("web.admin.staff.actions"),
      meta: { label: t("web.admin.staff.actions"), className: "text-right" },
      cell: ({ row }) => {
        const isSelf = !isBootstrap && row.original.id === actorId;
        return (
          <ToggleDisabledButton
            adminId={row.original.id}
            isDisabled={Boolean(row.original.disabledAt)}
            selfDisabled={isSelf}
          />
        );
      },
    },
  ];

  return (
    <>
      <InviteForm />

      {admins.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("web.admin.staff.noRows")}</p>
      ) : (
        <TableShell>
          <DataTable
            columns={columns}
            data={admins}
            sort={sort}
            onSortChange={setSort}
            getRowId={(row) => row.id}
          />
        </TableShell>
      )}
    </>
  );
}
