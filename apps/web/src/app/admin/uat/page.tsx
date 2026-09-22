import { requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { isProductionDeployment } from "@/lib/env";
import { UatRunbook } from "./uat-runbook";
import { getT } from "@/lib/i18n";

export default async function AdminUatPage() {
  await requireAdmin("superadmin", "uat:run");
  const t = await getT();

  const states = await prisma.uatChecklistState.findMany({
    where: { targetEnv: { in: ["preview", "production"] } },
  });
  const initialChecked: Record<"preview" | "production", string[]> = {
    preview: [],
    production: [],
  };
  for (const s of states) {
    if (s.targetEnv === "preview" || s.targetEnv === "production") {
      initialChecked[s.targetEnv] = Array.isArray(s.checkedItems)
        ? (s.checkedItems as string[])
        : [];
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.uat.title")} />
        <p className="text-sm text-muted-foreground">{t("web.admin.uat.subtitle")}</p>
      </header>
      <UatRunbook initialChecked={initialChecked} isProdDeployment={isProductionDeployment()} />
    </div>
  );
}
