import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { AvailabilityForm } from "@/app/(app)/onboarding/availability/availability-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { intlLocale, weekdayLabels as intlWeekdayLabels } from "@spiralclass/shared";

export default async function AvailabilitySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const params = await searchParams;
  const rules = await prisma.availabilityRule.findMany({
    where: { teacherId: teacher.id },
    orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
  });

  const activeWeekdays = new Set(rules.map((r) => r.weekday));
  // Two-letter day names, Sunday first, from Intl — this was a table holding
  // English and Spanish. The first two letters of the short name are what
  // those tables spelled out ("Su", "Do"), and what French abbreviates to.
  const weekdayLabels = intlWeekdayLabels(locale, "short").map(
    (name) => name.charAt(0).toLocaleUpperCase(intlLocale(locale)) + name.slice(1, 2),
  );

  // D-53: rules are interpreted in the zone they were written in, frozen at
  // save. If the teacher later changed their account zone, existing hours stay
  // in the old zone (so booked instants can't desync). Surface that — the wall
  // clock below reads in `staleZone`, and saving restamps it to the new zone,
  // shifting every slot by the offset.
  const staleZone = rules.find((r) => r.timezone !== teacher.timezone)?.timezone ?? null;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <PageHeader title={t("web.settings.availability.title")} />
        <p className="text-sm text-muted-foreground">{t("web.settings.availability.body")}</p>
        <p className="text-sm">
          {t("web.settings.availability.holidayPrompt")}{" "}
          <Link href="/settings/blocked-dates" className="underline">
            {t("web.settings.availability.blockDatesLink")}
          </Link>
          .
        </p>
      </div>

      {/* Day-dot visual summary */}
      {rules.length > 0 && (
        <div className="flex gap-1.5">
          {[1, 2, 3, 4, 5, 6, 0].map((weekday) => {
            const active = activeWeekdays.has(weekday);
            return (
              <div key={weekday} className="flex flex-col items-center gap-1">
                <span className="text-sm text-muted-foreground">{weekdayLabels[weekday]}</span>
                <span
                  className={cn("h-2.5 w-2.5 rounded-full", active ? "bg-primary" : "bg-muted")}
                  aria-hidden
                />
                <span className="sr-only">
                  {active
                    ? t("web.settings.availability.dayActive")
                    : t("web.settings.availability.dayOff")}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {params.saved === "1" && (
        <Alert variant="success">
          <AlertDescription>{t("web.settings.availability.savedNotice")}</AlertDescription>
        </Alert>
      )}

      {staleZone && (
        <Alert variant="warning">
          <AlertDescription>
            {t("web.settings.availability.staleZoneWarning", {
              staleZone,
              timezone: teacher.timezone,
            })}
          </AlertDescription>
        </Alert>
      )}

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
        redirectTo="/settings/availability"
        submitLabel={t("web.settings.availability.submitLabel")}
      />
    </div>
  );
}
