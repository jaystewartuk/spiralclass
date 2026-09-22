import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { resolveDashboardTiles, type DashboardTilePref } from "@spiralclass/shared";
import { CustomizeDashboardTilesForm } from "@/components/dashboard/customize-tiles-form";

export default async function CustomizeDashboardPage() {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();

  const tiles = resolveDashboardTiles(teacher.dashboardTileOrder as DashboardTilePref[] | null);

  return (
    <PageShell width="reading">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard">{t("web.dashboard.customize.backToDashboard")}</Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("home.dayToDay")}</CardTitle>
          <CardDescription>{t("home.dayToDaySubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <CustomizeDashboardTilesForm tiles={tiles} locale={locale} />
        </CardContent>
      </Card>
    </PageShell>
  );
}
