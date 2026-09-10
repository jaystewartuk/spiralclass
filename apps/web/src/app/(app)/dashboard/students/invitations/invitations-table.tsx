"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import {
  cancelInvitationAction,
  copyInvitationLinkAction,
  resendInvitationAction,
} from "@/app/actions/invitations";
import type { InvitationDashboardRow, StudentInvitationState } from "@/lib/invitations/dashboard";

const FILTERS: Array<StudentInvitationState | "all"> = [
  "all",
  "not_invited",
  "pending",
  "accepted",
  "expired",
  "cancelled",
];

const BADGE_VARIANT: Record<
  StudentInvitationState,
  "success" | "warning" | "outline" | "secondary" | "info"
> = {
  accepted: "success",
  pending: "warning",
  expired: "outline",
  cancelled: "secondary",
  not_invited: "info",
};

export function InvitationsTable({ rows }: { rows: InvitationDashboardRow[] }) {
  const t = useT();
  const [filter, setFilter] = useState<StudentInvitationState | "all">("all");

  const filtered = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.state === filter)),
    [rows, filter],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={
              filter === f
                ? "bg-primary text-primary-foreground rounded-full px-3 py-1 text-xs font-medium"
                : "bg-muted text-muted-foreground hover:bg-muted/70 rounded-full px-3 py-1 text-xs font-medium"
            }
          >
            {f === "all"
              ? t("web.dashboard.invitations.filter.all")
              : t(`web.dashboard.invitations.status.${f}`)}
          </button>
        ))}
      </div>

      <ul className="divide-y overflow-hidden rounded-md border">
        {filtered.map((row) => (
          <li
            key={row.studentId}
            className="flex flex-col gap-2 px-4 py-3 lg:flex-row lg:items-center lg:justify-between"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{row.studentName}</div>
              <div className="text-muted-foreground truncate text-xs">
                {row.email ?? t("web.dashboard.invitations.noEmail")}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={BADGE_VARIANT[row.state]}>
                {t(`web.dashboard.invitations.status.${row.state}`)}
              </Badge>
              <RowActions row={row} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowActions({ row }: { row: InvitationDashboardRow }) {
  const t = useT();
  const [pending, startTransition] = useTransition();

  const canManage =
    row.invitationId != null && (row.state === "pending" || row.state === "expired");

  const run = (fn: () => Promise<{ error?: string; ok?: string; url?: string } | undefined>) =>
    startTransition(async () => {
      const res = await fn();
      if (res?.error) toast.error(res.error);
      else if (res?.url) {
        try {
          await navigator.clipboard.writeText(res.url);
          toast.success(t("web.dashboard.invitations.linkCopied"));
        } catch {
          toast.message(res.url);
        }
      } else if (res?.ok) toast.success(res.ok);
    });

  const fd = () => {
    const f = new FormData();
    f.set("invitationId", row.invitationId ?? "");
    return f;
  };

  if (row.state === "not_invited") {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={`/dashboard/students/invitations/nuevo?student=${row.studentId}`}>
          {t("web.dashboard.invitations.action.invite")}
        </Link>
      </Button>
    );
  }

  if (!canManage) return null;

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => run(() => copyInvitationLinkAction(undefined, fd()))}
      >
        {t("web.dashboard.invitations.action.copyLink")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => run(() => resendInvitationAction(undefined, fd()))}
      >
        {t("web.dashboard.invitations.action.resend")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          if (window.confirm(t("web.dashboard.invitations.cancelConfirm"))) {
            run(() => cancelInvitationAction(undefined, fd()));
          }
        }}
      >
        {t("web.dashboard.invitations.action.cancel")}
      </Button>
    </div>
  );
}
