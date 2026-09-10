import { countryOptions } from "@spiralclass/shared";
import { PageHeader } from "@/components/ui/page-header";
import { TimezoneForm } from "./timezone-form";
import { COMMON_TIMEZONES } from "./timezones";
import { requireTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";

export default async function TimezoneStepPage() {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  return (
    <div className="space-y-6">
      <div>
        <PageHeader title={t("web.onboarding.timezone.confirmTitle")} />
        <p className="text-muted-foreground mt-1 text-sm">
          {t("web.onboarding.timezone.confirmSubtitle")}
        </p>
      </div>
      <TimezoneForm
        initialTimezone={teacher.timezone}
        initialPhoneE164={teacher.phoneE164 ?? null}
        initialCountry={teacher.country}
        initialPricingCurrency={teacher.pricingCurrency}
        initialTargetLanguage={teacher.targetLanguage ?? null}
        options={COMMON_TIMEZONES}
        countries={countryOptions(locale)}
      />
    </div>
  );
}
