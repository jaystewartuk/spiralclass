import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { BookingSlugForm } from "@/app/(app)/settings/booking-page/booking-slug-form";
import { requireTeacher } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { finishOnboardingAction } from "@/app/actions/onboarding";
import { getT } from "@/lib/i18n";

export default async function PreviewStepPage() {
  const teacher = await requireTeacher();
  const t = await getT();
  const appUrl = serverEnv().APP_URL;

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title={t("onboarding.preview.title")} />
        <p className="text-muted-foreground mt-1 text-sm">
          {t("web.onboarding.preview.shareHint")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{teacher.name}</CardTitle>
          <CardDescription>{t("home.timezone", { tz: teacher.timezone })}</CardDescription>
        </CardHeader>
        <CardContent>
          <BookingSlugForm initialSlug={teacher.bookingSlug} appUrl={appUrl} />
          <p className="text-muted-foreground mt-4 text-xs">
            {t("web.onboarding.preview.liveHint")}
          </p>
        </CardContent>
      </Card>

      <form action={finishOnboardingAction}>
        <Button type="submit">{t("onboarding.preview.finish")}</Button>
      </form>
    </div>
  );
}
