import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { buildInvitationDashboard } from "@/lib/invitations/dashboard";
import { InvitationsTable } from "./invitations-table";

// Teacher invitation dashboard (D-83): funnel stats + a filterable roster with
// per-student resend / cancel / copy-link actions.
export const dynamic = "force-dynamic";

export default async function InvitationsPage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();
  const { stats, rows } = await buildInvitationDashboard(teacher.id);

  const statTiles: Array<{ key: string; label: string; value: number }> = [
    { key: "total", label: t("web.dashboard.invitations.stat.total"), value: stats.totalStudents },
    { key: "invited", label: t("web.dashboard.invitations.stat.invited"), value: stats.invited },
    { key: "accepted", label: t("web.dashboard.invitations.stat.accepted"), value: stats.accepted },
    { key: "pending", label: t("web.dashboard.invitations.stat.pending"), value: stats.pending },
    { key: "expired", label: t("web.dashboard.invitations.stat.expired"), value: stats.expired },
    {
      key: "notInvited",
      label: t("web.dashboard.invitations.stat.notInvited"),
      value: stats.notInvited,
    },
  ];

  return (
    <PageShell width="default">
      <header className="flex items-start justify-between gap-3">
        <div>
          <Link
            href="/dashboard/students"
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            {t("web.dashboard.invitations.backToStudents")}
          </Link>
          <PageHeader title={t("web.dashboard.invitations.title")} />
          <p className="text-muted-foreground text-sm">{t("web.dashboard.invitations.subtitle")}</p>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link href="/dashboard/students/invitations/nuevo">
            {t("web.dashboard.invitations.inviteCta")}
          </Link>
        </Button>
      </header>

      <section className="grid grid-cols-3 gap-2 lg:grid-cols-6">
        {statTiles.map((tile) => (
          <div key={tile.key} className="bg-muted/40 rounded-md border px-3 py-2 text-center">
            <div className="text-lg font-semibold tabular-nums">{tile.value}</div>
            <div className="text-muted-foreground text-sm leading-tight">{tile.label}</div>
          </div>
        ))}
      </section>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("web.dashboard.invitations.empty")}</p>
      ) : (
        <InvitationsTable rows={rows} />
      )}
    </PageShell>
  );
}
