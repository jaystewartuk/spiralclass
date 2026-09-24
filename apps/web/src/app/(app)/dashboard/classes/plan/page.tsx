import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { NotebookPen } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BackLink } from "@/components/back-link";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { toYMD, zonedWallClockToUtc } from "@/lib/tz";
import { shiftDay, ymdToUtcNoon } from "@/lib/calendar-grid";
import {
  capitalizeFirst,
  formatZonedDayHeader,
  formatZonedTime,
  timezoneCityLabel,
} from "@/lib/date-display";
import { dayPlanHref, isLastClassOfPackage, resolvePlanDay } from "@/lib/lesson-notes/day-plan";
import { PlanClassCard, type PlanClass } from "./plan-class-card";

/**
 * The day plan — "what am I covering with each student today?" on one page.
 *
 * A teacher asked for a place to plan her classes, separate from materials, and
 * showed the notebook she uses for it: a page per day, each student's name, a
 * few bullets under it. Every piece of that already existed per class (private
 * teacher cues, copy from last class), but only one class at a time, three
 * clicks deep. This page is the notebook view over the same rows — no new
 * table, so what she writes here is what she ticks off during the call.
 *
 * Tenancy: the one query is filtered by `teacherId` from auth; the notes and
 * package are reached only through her own bookings.
 */

/** A class that is still going to happen or did happen. Cancelled and moved ones have no plan. */
const PLANNED_STATUSES = ["scheduled", "completed", "no_show"] as const;

const PLAN_SELECT = {
  id: true,
  scheduledStart: true,
  scheduledEnd: true,
  student: { select: { name: true } },
  package: {
    select: {
      classesTotal: true,
      classesUsed: true,
      // Bounded by the package size. Read so "is this the last class?" can
      // ask whether anything in the package is still booked after it.
      bookings: {
        where: { status: "scheduled", countsAgainstPackage: true },
        select: { scheduledStart: true },
      },
    },
  },
  lessonNotes: {
    where: { audience: "teacher", kind: "text" },
    select: { id: true, body: true, position: true, doneAt: true },
    orderBy: { position: "asc" },
  },
} satisfies Prisma.BookingSelect;

export default async function DayPlanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [teacher, locale, t, params] = await Promise.all([
    requireOnboardedTeacher(),
    getPreferredLocale(),
    getT(),
    searchParams,
  ]);
  const tz = teacher.timezone;

  // The day is a day on HER wall clock, bounded by her local midnights (a DST
  // transition makes one of them 23 or 25 hours long).
  const todayYmd = toYMD(new Date(), tz);
  const ymd = resolvePlanDay(params.d, todayYmd);
  const dayStart = zonedWallClockToUtc(ymd, "00:00", tz);
  const dayEnd = zonedWallClockToUtc(shiftDay(ymd, 1), "00:00", tz);

  const rows = await prisma.booking.findMany({
    where: {
      teacherId: teacher.id,
      status: { in: [...PLANNED_STATUSES] },
      scheduledStart: { gte: dayStart, lt: dayEnd },
    },
    orderBy: { scheduledStart: "asc" },
    select: PLAN_SELECT,
  });

  const items: PlanClass[] = rows.map((b) => ({
    bookingId: b.id,
    studentName: b.student.name,
    timeRange: `${formatZonedTime(b.scheduledStart, tz, locale)} – ${formatZonedTime(b.scheduledEnd, tz, locale)}`,
    lastOfPackage: isLastClassOfPackage(
      b.package,
      b.package?.bookings.filter((o) => o.scheduledStart > b.scheduledStart).length ?? 0,
    ),
    cues: b.lessonNotes.map((n) => ({
      id: n.id,
      body: n.body,
      position: n.position,
      done: n.doneAt != null,
    })),
  }));

  const dayLabel = capitalizeFirst(formatZonedDayHeader(ymdToUtcNoon(ymd), "UTC", locale), locale);

  return (
    <PageShell>
      <BackLink href="/dashboard/classes" label={t("classes.title")} />
      <PageHeader
        title={t("web.dashboard.classes.plan.title")}
        description={
          <>
            {dayLabel} ·{" "}
            {t("web.dashboard.home.schedule.timesShownIn", { tz: timezoneCityLabel(tz) })}
          </>
        }
        actions={
          <nav aria-label={t("web.dashboard.classes.plan.dayNav")} className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={dayPlanHref(shiftDay(ymd, -1), todayYmd)}>
                {t("web.dashboard.classes.plan.previousDay")}
              </Link>
            </Button>
            {ymd !== todayYmd && (
              <Button asChild variant="outline" size="sm">
                <Link href={dayPlanHref(todayYmd, todayYmd)}>
                  {t("web.dashboard.classes.plan.today")}
                </Link>
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link href={dayPlanHref(shiftDay(ymd, 1), todayYmd)}>
                {t("web.dashboard.classes.plan.nextDay")}
              </Link>
            </Button>
          </nav>
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={NotebookPen}
          title={t("web.dashboard.classes.plan.emptyTitle")}
          description={t("web.dashboard.classes.plan.emptyBody")}
        />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("web.dashboard.classes.plan.help")}</p>
          {items.map((item) => (
            <PlanClassCard key={item.bookingId} item={item} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
