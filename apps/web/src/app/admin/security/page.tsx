import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { resolveAdminActor } from "@/lib/admin";
import { getAuthUser } from "@/lib/auth";
import { hasValidAdminStepUp } from "@/lib/auth/admin-stepup";
import { getT } from "@/lib/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminMfaForm } from "./admin-mfa-form";

// docs/decisions/D-25.md (narrowed by D-40) — mandatory admin
// TOTP. This is the ONE /admin surface gated by resolveAdminActor() (no
// requireAdmin) rather than requireAdmin(): it's where an admin enrols AND
// where they present a per-session step-up code, so requiring either to reach
// the page that grants them would loop forever. An admin who is enrolled AND
// already holds a fresh step-up proof (security audit H-1) has nothing to do
// here, so we send them on to /admin; otherwise we render enrolment (not yet
// enrolled) or the step-up prompt (enrolled, proof missing/expired).
export default async function AdminSecurityPage() {
  await resolveAdminActor();
  const user = await getAuthUser();
  const enrolled = Boolean(user?.twoFactorEnabled);
  if (enrolled && user && (await hasValidAdminStepUp(user.id))) redirect("/admin");
  const t = await getT();

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <header>
        <PageHeader title={t("web.admin.security.title")} />
        <p className="text-sm text-muted-foreground">{t("web.admin.security.body")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("web.admin.security.cardTitle")}</CardTitle>
          <CardDescription>{t("web.admin.security.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <AdminMfaForm alreadyEnrolled={enrolled} />
        </CardContent>
      </Card>
    </div>
  );
}
