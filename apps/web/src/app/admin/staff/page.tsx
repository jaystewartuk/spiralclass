import { isBootstrapActor, requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { getT } from "@/lib/i18n";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StaffTable } from "./staff-table";

export default async function AdminStaffPage() {
  const actor = await requireAdmin("superadmin");
  const t = await getT();
  // No pagination or server-driven sort here — the staff roster is small and
  // loads in full; StaffTable sorts every column instantly, client-side.
  const admins = await prisma.adminUser.findMany({
    orderBy: [{ disabledAt: "asc" }, { createdAt: "desc" }],
    include: {
      createdBy: { select: { email: true } },
    },
  });

  const isBootstrap = isBootstrapActor(actor);

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.staff.title")} />
        <p className="text-muted-foreground text-sm">
          {t("web.admin.staff.subtitlePrefix")}
          <code className="bg-muted mx-1 rounded px-1 py-0.5">SUPERUSER_EMAILS</code>
          {t("web.admin.staff.subtitleSuffix")}
        </p>
        {isBootstrap ? (
          <Alert variant="warning" className="mt-2">
            <AlertDescription>{t("web.admin.staff.bootstrapNotice")}</AlertDescription>
          </Alert>
        ) : null}
      </header>

      <StaffTable admins={admins} actorId={actor.id} isBootstrap={isBootstrap} />
    </div>
  );
}
