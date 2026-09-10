import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/page-header";
import { requireTeacher } from "@/lib/auth";
import { AvailabilityForm } from "./availability-form";
import { getT } from "@/lib/i18n";

export default async function AvailabilityStepPage() {
  const teacher = await requireTeacher();
  const t = await getT();
  const rules = await prisma.availabilityRule.findMany({
    where: { teacherId: teacher.id },
    orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
  });

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title={t("web.onboarding.availability.setTitle")} />
        <p className="mt-1 text-sm text-muted-foreground">
          {t("web.onboarding.availability.setSubtitle")}
        </p>
      </div>
      <AvailabilityForm
        initial={{
          bufferMin: teacher.bufferMin,
          minAdvanceH: teacher.minAdvanceH,
          maxAdvanceDays: teacher.maxAdvanceDays,
          ranges: rules.map((r) => ({
            weekday: r.weekday,
            startTime: r.startTime,
            endTime: r.endTime,
          })),
        }}
      />
    </div>
  );
}
