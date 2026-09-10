import { isConnectCountrySupported } from "@spiralclass/shared";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { requireTeacher } from "@/lib/auth";
import { TemplatesForm } from "./templates-form";
import { getT } from "@/lib/i18n";

export default async function TemplatesStepPage() {
  const teacher = await requireTeacher();
  const t = await getT();
  // A teacher outside the Stripe Connect payout circle never gets a Stripe
  // rail — Wise is her only rail (D-58) — so the form drops the "Stripe
  // price" / Wise-discount split for a single plain price. Mirrors the gate
  // in the settings payments page.
  const payoutCountrySupported = isConnectCountrySupported(teacher.country);
  const templates = await prisma.packageTemplate.findMany({
    where: { teacherId: teacher.id, archived: false },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title={t("onboarding.templates.title")} />
        <p className="text-muted-foreground mt-1 text-sm">
          {t("web.onboarding.templates.starterHint")}
        </p>
      </div>
      <TemplatesForm
        initial={templates.map((t) => ({
          id: t.id,
          name: t.name,
          subject: t.subject,
          classCount: t.classCount,
          singleClass: t.singleClass,
          classDurationMin: t.classDurationMin,
          priceMinorUnits: t.priceMinorUnits,
          transferPriceMinorUnits: t.transferPriceMinorUnits,
          expirationMonths: t.expirationMonths,
        }))}
        payoutCountrySupported={payoutCountrySupported}
        showSubject={false}
        emptyDescription={t("web.onboarding.templates.noPackages")}
      />
    </div>
  );
}
