import { notFound, redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { BackLink } from "@/components/back-link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HardLink } from "@/components/calendar/hard-link";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateSlots, type Slot } from "@/lib/slots";
import { loadGoogleBusyBlocks } from "@/lib/calendar/google/busy";
import { bookingWhen, formatZonedDate, formatZonedTime } from "@/lib/date-display";
import { getDualZoneTime, minutesOfDayInTz } from "@spiralclass/shared";
import { getPreferredLocale, getT, type AppLocale } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { toYMD } from "@/lib/tz";
import { addCalendarDays, firstAvailableDay } from "@/lib/booking/next-available";
import { groupSlotsByDayPart, resolveBookableDay, type DayPart } from "@/lib/booking/teacher-book";
import { TeacherRescheduleSlotButton } from "./teacher-reschedule-slot-button";

/**
 * Teacher-side "change date and time" picker.
 *
 * The class the teacher needs to move is the one she has to move on the day
 * something falls through, and until now the only way to do it was to cancel
 * the class and book a new one: two screens, a cancellation notice sent to a
 * student whose class was not actually cancelled, and no link between the old
 * class and the new one. This screen moves it as one act.
 *
 * IT IS THE BOOKING SCREEN'S PICKER, DELIBERATELY. Same generator, same
 * day-part grouping, same confirm-before-commit slot button, same
 * both-zones-on-the-button rule — a teacher should not have to learn a second
 * way to choose a time on the same dashboard. What differs is only what a
 * reschedule is: the day it opens on is the class's own day, the class's
 * current slot is excluded (moving a class to the time it already has is not a
 * move), and the class being moved does not block its own replacement.
 *
 * The window it can move within is the same one the class could have been
 * booked in — today through the earlier of her max-advance horizon and the
 * package's expiration — with one exemption, applied in the action as well as
 * here: her own `minAdvanceH` does not bind her (see the action's doc
 * comment). Everything else that describes reality still does.
 */
export default async function TeacherReschedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { bookingId } = await params;
  const sp = await searchParams;

  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();

  // Tenant isolation: scoped to the authenticated teacher, like every other
  // read on this route tree.
  const old = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId: teacher.id },
    select: {
      id: true,
      status: true,
      scheduledStart: true,
      student: { select: { name: true, timezone: true } },
      package: { select: { classDurationMin: true, expiresAt: true } },
    },
  });
  if (!old) notFound();
  // Only a class that is still going to happen can be moved. The action
  // refuses this too — this redirect is so the teacher never lands on a picker
  // that cannot commit anything.
  if (old.status !== "scheduled") redirect(`/dashboard/classes/${old.id}`);

  const now = new Date();
  const tz = teacher.timezone;
  const studentTz = old.student.timezone;
  const studentName = old.student.name;
  const classDurationMin = old.package.classDurationMin;
  const originalLocalDate = toYMD(old.scheduledStart, tz);

  // Navigable range: today (her zone) through the earlier of the max-advance
  // horizon and the package's expiration. When the package has already
  // lapsed the range collapses to today and the expiry filter below leaves it
  // empty, which is the honest answer — she extends the package first.
  const todayLocal = toYMD(now, tz);
  const horizonUtc = new Date(now.getTime() + teacher.maxAdvanceDays * 24 * 3600_000);
  const horizonYmd =
    old.package.expiresAt && old.package.expiresAt < horizonUtc
      ? toYMD(old.package.expiresAt, tz)
      : toYMD(horizonUtc, tz);
  const lastNavigable = horizonYmd < todayLocal ? todayLocal : horizonYmd;

  // One burst of reads for the whole navigable window, so `slotsForDay` below
  // is pure and can be called per candidate day — by the auto-land search and
  // by the "next open day" button — without another round trip.
  const windowStartUtc = new Date(`${todayLocal}T00:00:00Z`);
  const windowEndUtc = new Date(`${lastNavigable}T00:00:00Z`);
  const readFrom = new Date(windowStartUtc.getTime() - 24 * 3600_000);
  const readTo = new Date(windowEndUtc.getTime() + 48 * 3600_000);

  const [rules, blocked, googleBusy, bookings] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { teacherId: teacher.id } }),
    prisma.blockedDate.findMany({
      where: { teacherId: teacher.id, endsAt: { gt: readFrom }, startsAt: { lt: readTo } },
    }),
    // Google busy-import: empty unless she connected Google.
    loadGoogleBusyBlocks(teacher.id, prisma),
    prisma.booking.findMany({
      where: {
        teacherId: teacher.id,
        status: "scheduled",
        scheduledStart: { gte: readFrom, lt: readTo },
        // The class being moved must not block its own replacement.
        NOT: { id: old.id },
      },
      select: { scheduledStart: true, scheduledEnd: true, bufferMinSnapshot: true },
    }),
  ]);

  const slotTeacher = {
    timezone: tz,
    bufferMin: teacher.bufferMin,
    // Her own lead-time rule does not bind her — the same bypass the
    // self-serve booking screen takes, and the action applies it too.
    minAdvanceH: 0,
    maxAdvanceDays: teacher.maxAdvanceDays,
  };
  const blockedDates = [...blocked, ...googleBusy];

  const slotsForDay = (ymd: string): Slot[] =>
    generateSlots({
      date: ymd,
      classDurationMin,
      teacher: slotTeacher,
      availabilityRules: rules,
      blockedDates,
      existingBookings: bookings,
      now,
    }).filter(
      (c) =>
        c.startUtc.getTime() !== old.scheduledStart.getTime() &&
        (!old.package.expiresAt || c.startUtc <= old.package.expiresAt),
    );

  // Which day to show: an explicit `?date` (clamped into the window, and
  // discarded outright when it is not a calendar date at all), else the
  // class's own day — or, when that day has nothing left, the next day that
  // does, so she is not met with an empty grid.
  const requested = resolveBookableDay(sp.date, todayLocal, lastNavigable);
  const selectedDate =
    requested ??
    (slotsForDay(originalLocalDate).length > 0
      ? originalLocalDate
      : (firstAvailableDay(
          originalLocalDate < todayLocal ? todayLocal : originalLocalDate,
          lastNavigable,
          (d) => slotsForDay(d).length > 0,
        ) ?? originalLocalDate));

  const prevDate = addCalendarDays(selectedDate, -1);
  const nextDate = addCalendarDays(selectedDate, 1);
  const canGoPrev = prevDate >= todayLocal;
  const canGoNext = nextDate <= lastNavigable;

  const slots = slotsForDay(selectedDate);
  const nextAvailableDate =
    slots.length === 0
      ? firstAvailableDay(selectedDate, lastNavigable, (d) => slotsForDay(d).length > 0)
      : null;

  const dayHref = (ymd: string) => `/dashboard/classes/${old.id}/reschedule?date=${ymd}`;
  const noonOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`);

  return (
    <PageShell width="reading">
      <BackLink
        href={`/dashboard/classes/${old.id}`}
        label={t("web.dashboard.classes.reschedule.backToClass")}
      />
      <PageHeader
        title={t("web.dashboard.classes.reschedule.title")}
        description={t("web.dashboard.classes.reschedule.subtitle", {
          when: bookingWhen(
            old.scheduledStart,
            tz,
            { tz: studentTz ?? tz, label: studentName },
            locale,
            t,
          ).when,
        })}
      />

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between gap-2">
            <Button asChild variant="outline" size="sm" disabled={!canGoPrev}>
              <HardLink
                href={dayHref(prevDate)}
                aria-label={t("web.dashboard.classes.reschedule.previousDay")}
                aria-disabled={!canGoPrev}
                tabIndex={canGoPrev ? undefined : -1}
                className={canGoPrev ? undefined : "pointer-events-none opacity-50"}
              >
                <ChevronLeft className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">
                  {t("web.dashboard.classes.reschedule.previousDay")}
                </span>
              </HardLink>
            </Button>
            <p className="text-center text-sm font-medium">
              {formatZonedDate(noonOf(selectedDate), tz, locale)}
            </p>
            <Button asChild variant="outline" size="sm" disabled={!canGoNext}>
              <HardLink
                href={dayHref(nextDate)}
                aria-label={t("web.dashboard.classes.reschedule.nextDay")}
                aria-disabled={!canGoNext}
                tabIndex={canGoNext ? undefined : -1}
                className={canGoNext ? undefined : "pointer-events-none opacity-50"}
              >
                <span className="hidden sm:inline">
                  {t("web.dashboard.classes.reschedule.nextDay")}
                </span>
                <ChevronRight className="h-4 w-4 sm:ml-1" />
              </HardLink>
            </Button>
          </div>

          {slots.length === 0 ? (
            <div className="border-border/60 bg-muted/30 space-y-3 rounded-md border p-4 text-center">
              <p className="text-muted-foreground text-sm">
                {t("web.dashboard.classes.reschedule.noTimesAvailable")}
              </p>
              {nextAvailableDate ? (
                <Button
                  asChild
                  className="h-auto min-h-11 max-w-full py-2 text-center whitespace-normal lg:min-h-10"
                >
                  <HardLink href={dayHref(nextAvailableDate)}>
                    {t("web.dashboard.classes.reschedule.goToNextAvailableDay", {
                      date: formatZonedDate(noonOf(nextAvailableDate), tz, locale),
                    })}
                  </HardLink>
                </Button>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t("web.dashboard.classes.reschedule.noTimesLeftInWindow")}
                </p>
              )}
            </div>
          ) : (
            <SlotGrid
              bookingId={old.id}
              slots={slots}
              teacherTimezone={tz}
              studentTimezone={studentTz && studentTz !== tz ? studentTz : null}
              studentName={studentName}
              classDurationMin={classDurationMin}
              locale={locale}
              now={now}
              t={t}
            />
          )}

          <p className="text-muted-foreground text-xs">
            {t("web.dashboard.classes.reschedule.hint")}
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/**
 * The day's open times, banded morning/afternoon/evening.
 *
 * Lifted wholesale from the self-serve booking screen rather than reinvented:
 * the bands, the two clocks on every button and the spelled-out aria label are
 * the decisions that screen already made about picking a time as a teacher,
 * and a second grid that made them differently would be the bug.
 */
function SlotGrid({
  bookingId,
  slots,
  teacherTimezone,
  studentTimezone,
  studentName,
  classDurationMin,
  locale,
  now,
  t,
}: {
  bookingId: string;
  slots: Slot[];
  teacherTimezone: string;
  studentTimezone: string | null;
  studentName: string;
  classDurationMin: number;
  locale: AppLocale;
  now: Date;
  t: TFunction;
}) {
  const DAY_PART_LABEL: Record<DayPart, string> = {
    morning: t("web.dashboard.classes.book.dayPart.morning"),
    afternoon: t("web.dashboard.classes.book.dayPart.afternoon"),
    evening: t("web.dashboard.classes.book.dayPart.evening"),
  };
  // `minutesOfDayInTz` is the one helper allowed to read an hour out of a zone
  // rather than print one (tests/config/time-format-consistency.test.ts).
  const groups = groupSlotsByDayPart(slots, (s) =>
    Math.floor(minutesOfDayInTz(s.startUtc, teacherTimezone) / 60),
  );

  return (
    <div className="space-y-4">
      {groups.map(({ part, slots: partSlots }) => (
        <section key={part} aria-labelledby={`reschedule-part-${part}`}>
          <h3
            id={`reschedule-part-${part}`}
            className="text-muted-foreground mb-2 text-sm font-semibold"
          >
            {DAY_PART_LABEL[part]}
          </h3>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {partSlots.map((s) => {
              const timeLabel = formatZonedTime(s.startUtc, teacherTimezone, locale);
              const dual = studentTimezone
                ? getDualZoneTime(
                    s.startUtc,
                    { tz: teacherTimezone, label: t("web.dualZone.yourTime") },
                    { tz: studentTimezone, label: studentName },
                    locale,
                    now,
                  )
                : null;
              // The other zone's clock, plus a day marker when the calendar
              // date differs there — moving a class across a date rollover is
              // the mistake nobody notices until the class is missed.
              const theirTime = dual
                ? dual.sameCalendarDate
                  ? dual.other.timeLabel
                  : `${dual.other.timeLabel} (${dual.other.dateLabel})`
                : undefined;
              const w = bookingWhen(
                s.startUtc,
                teacherTimezone,
                { tz: studentTimezone ?? teacherTimezone, label: studentName },
                locale,
                t,
              );
              const moveLabel = t("web.dashboard.classes.reschedule.moveToLabel", {
                label: timeLabel,
              });
              return (
                <li key={s.startUtc.toISOString()}>
                  <TeacherRescheduleSlotButton
                    bookingId={bookingId}
                    startUtc={s.startUtc.toISOString()}
                    label={timeLabel}
                    secondaryLabel={theirTime}
                    ariaLabel={
                      theirTime
                        ? `${moveLabel}. ${t("web.dashboard.classes.book.theirTime", {
                            time: theirTime,
                            name: studentName,
                          })}`
                        : moveLabel
                    }
                    summary={`${w.when} · ${w.whenSecondary}`}
                    subtitle={`${classDurationMin} min · ${studentName}`}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
