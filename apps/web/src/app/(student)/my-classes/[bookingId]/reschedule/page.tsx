import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { HardLink } from "@/components/calendar/hard-link";
import { requireStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { generateSlots } from "@/lib/slots";
import { loadGoogleBusyBlocks } from "@/lib/calendar/google/busy";
import { formatZonedDate, formatZonedTime, bookingWhen } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { canStudentRescheduleBooking, scheduleChangeBudget } from "@/lib/cancellation/classify";
import { studentIdentityIds } from "@/lib/students/identity";
import { firstAvailableDay } from "@/lib/booking/next-available";
import { RescheduleSlotButton } from "./reschedule-slot-button";

// Reschedule slot picker. The same-week (Mon–Sun) window is gone (review
// item 15): a class can move to any day the student could book fresh —
// bounded by today, the teacher's max-advance window, and the package's
// expiration. Runs the generator per day and excludes the original
// slot itself.
//
// We pass `?date=YYYY-MM-DD` (a local date in the teacher's tz) so the user
// can flip between days. Default = the original booking's local date.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export default async function ReschedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { bookingId } = await params;
  const sp = await searchParams;

  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const t = await getT();

  const old = await prisma.booking.findFirst({
    where: { id: bookingId, studentId: { in: await studentIdentityIds(student) } },
    include: {
      teacher: true,
      package: {
        select: {
          classDurationMin: true,
          expiresAt: true,
          classesTotal: true,
          scheduleChangesUsed: true,
        },
      },
    },
  });
  if (!old) notFound();

  const now = new Date();
  const eligibility = canStudentRescheduleBooking({
    now,
    scheduledStart: old.scheduledStart,
    status: old.status,
    scheduleChangesUsed: old.package.scheduleChangesUsed,
    scheduleChangesAllowed: scheduleChangeBudget(old.package.classesTotal),
  });
  if (!eligibility.ok) {
    redirect(`/my-classes/${old.id}`);
  }

  // Day navigation stays in the teacher's own zone — availability windows
  // and slot generation are fundamentally organized by the teacher's
  // calendar day, not the student's. Individual slot times shown to the
  // student below use the dual-timezone standard (student primary).
  const tz = old.teacher.timezone;
  const studentTz = student.timezone ?? tz;
  const originalLocalDate = localYmd(old.scheduledStart, tz);

  // Navigable range: today (teacher tz) through the earlier of the
  // max-advance horizon and the package expiration.
  const todayLocal = localYmd(now, tz);
  const horizonUtc = new Date(now.getTime() + old.teacher.maxAdvanceDays * 24 * 3600_000);
  const lastNavigable =
    old.package.expiresAt && old.package.expiresAt < horizonUtc
      ? localYmd(old.package.expiresAt, tz)
      : localYmd(horizonUtc, tz);

  // One burst for the whole navigable window (not just one day): lets
  // slotsForDay be called cheaply per candidate day below, both for the
  // auto-land search and the "next available" button — mirrors
  // my-classes/book/page.tsx's identical windowing, which this screen used to
  // lack entirely (single day ± 24h). A student landing on a day with nothing
  // left, with no forward search and no button, was stranded on "no times
  // available" — reproduced deterministically depending on wall-clock time
  // against the teacher's fixed availability windows, not a rare flake.
  const windowStartUtc = new Date(`${todayLocal}T00:00:00Z`);
  const windowEndUtc = new Date(`${lastNavigable}T00:00:00Z`);

  const [rules, blocked, googleBusy, bookings] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { teacherId: old.teacherId } }),
    prisma.blockedDate.findMany({
      where: {
        teacherId: old.teacherId,
        endsAt: { gt: new Date(windowStartUtc.getTime() - 24 * 3600_000) },
        startsAt: { lt: new Date(windowEndUtc.getTime() + 48 * 3600_000) },
      },
    }),
    // Google busy-import (Phase 3): empty unless the teacher connected Google.
    loadGoogleBusyBlocks(old.teacherId, prisma),
    prisma.booking.findMany({
      where: {
        teacherId: old.teacherId,
        status: "scheduled",
        scheduledStart: {
          gte: new Date(windowStartUtc.getTime() - 24 * 3600_000),
          lt: new Date(windowEndUtc.getTime() + 48 * 3600_000),
        },
        NOT: { id: old.id },
      },
      select: { scheduledStart: true, scheduledEnd: true, bufferMinSnapshot: true },
    }),
  ]);

  const slotTeacher = {
    timezone: tz,
    bufferMin: old.teacher.bufferMin,
    minAdvanceH: old.teacher.minAdvanceH,
    maxAdvanceDays: old.teacher.maxAdvanceDays,
  };
  const blockedDates = [...blocked, ...googleBusy];

  // Slot generation already enforces minAdvance + maxAdvance; on top of that, exclude
  // the original booking's own slot (you can't reschedule to the same time)
  // and anything past the package's expiration. Pure/sync — safe to call once
  // per candidate day in the forward search below without another DB round trip.
  const slotsForDay = (ymd: string) =>
    generateSlots({
      date: ymd,
      classDurationMin: old.package.classDurationMin,
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

  // Which day to show. An explicit ?date is the student's choice (validated
  // into the window, same redirect-on-out-of-range as before). With no
  // explicit date, default to the original booking's own day as before — but
  // if THAT lands empty, auto-advance to the next available day instead of
  // parking her on an empty state. Mirrors book/page.tsx's auto-land.
  let requestedDate: string;
  if (sp.date && YMD.test(sp.date)) {
    requestedDate = sp.date;
    if (requestedDate < todayLocal || requestedDate > lastNavigable) {
      redirect(`/my-classes/${old.id}/reschedule?date=${originalLocalDate}`);
    }
  } else {
    requestedDate =
      slotsForDay(originalLocalDate).length > 0
        ? originalLocalDate
        : (firstAvailableDay(originalLocalDate, lastNavigable, (d) => slotsForDay(d).length > 0) ??
          originalLocalDate);
  }

  const prevDate = shiftYmd(requestedDate, -1);
  const nextDate = shiftYmd(requestedDate, 1);
  const canGoPrev = prevDate >= todayLocal;
  const canGoNext = nextDate <= lastNavigable;

  const slots = slotsForDay(requestedDate);

  // "Jump to the next open day" for when the selected day is empty — the
  // explicit counterpart to the auto-land above, for a student who
  // deliberately browsed to (or deep-linked) an empty day via prev/next.
  const nextAvailableDate =
    slots.length === 0
      ? firstAvailableDay(requestedDate, lastNavigable, (d) => slotsForDay(d).length > 0)
      : null;
  const nextAvailableDisplay = nextAvailableDate
    ? formatZonedDate(new Date(`${nextAvailableDate}T12:00:00Z`), tz, locale)
    : null;

  const dateDisplay = new Date(`${requestedDate}T12:00:00Z`);

  return (
    <PageShell width="reading">
      <div>
        <Link href={`/my-classes/${old.id}`} className="text-sm underline">
          {t("web.myClasses.backToClass")}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("web.myClasses.reschedule.title")}</CardTitle>
          <CardDescription>
            {t("web.myClasses.reschedule.subtitle", {
              when: bookingWhen(
                old.scheduledStart,
                studentTz,
                { tz, label: old.teacher.name },
                locale,
                t,
              ).when,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <Button asChild variant="outline" size="sm" disabled={!canGoPrev}>
              <HardLink
                href={`/my-classes/${old.id}/reschedule?date=${prevDate}`}
                aria-label={t("web.myClasses.reschedule.previousDay")}
                aria-disabled={!canGoPrev}
                tabIndex={canGoPrev ? undefined : -1}
                className={canGoPrev ? undefined : "pointer-events-none opacity-50"}
              >
                <ChevronLeft className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">
                  {t("web.myClasses.reschedule.previousDay")}
                </span>
              </HardLink>
            </Button>
            <p className="text-center text-sm font-medium">
              {formatZonedDate(dateDisplay, tz, locale)}
            </p>
            <Button asChild variant="outline" size="sm" disabled={!canGoNext}>
              <HardLink
                href={`/my-classes/${old.id}/reschedule?date=${nextDate}`}
                aria-label={t("web.myClasses.reschedule.nextDay")}
                aria-disabled={!canGoNext}
                tabIndex={canGoNext ? undefined : -1}
                className={canGoNext ? undefined : "pointer-events-none opacity-50"}
              >
                <span className="hidden sm:inline">{t("web.myClasses.reschedule.nextDay")}</span>
                <ChevronRight className="h-4 w-4 sm:ml-1" />
              </HardLink>
            </Button>
          </div>

          {slots.length === 0 ? (
            <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-4 text-center">
              <p className="text-sm text-muted-foreground">
                {t("web.myClasses.reschedule.noTimesAvailable")}
              </p>
              {nextAvailableDate ? (
                <Button
                  asChild
                  className="h-auto min-h-11 max-w-full py-2 text-center whitespace-normal lg:min-h-10"
                >
                  <HardLink href={`/my-classes/${old.id}/reschedule?date=${nextAvailableDate}`}>
                    {t("web.myClasses.reschedule.goToNextAvailableDay", {
                      date: nextAvailableDisplay ?? "",
                    })}
                  </HardLink>
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("web.myClasses.reschedule.noTimesLeftInWindow")}
                </p>
              )}
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {slots.map((s) => (
                <li key={s.startUtc.toISOString()}>
                  <RescheduleSlotButton
                    bookingId={old.id}
                    startUtc={s.startUtc.toISOString()}
                    label={formatZonedTime(s.startUtc, studentTz, locale)}
                    summary={(() => {
                      const w = bookingWhen(
                        s.startUtc,
                        studentTz,
                        { tz, label: old.teacher.name },
                        locale,
                        t,
                      );
                      return `${w.when} · ${w.whenSecondary}`;
                    })()}
                    subtitle={`${old.package.classDurationMin} min · ${old.teacher.name}`}
                  />
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-muted-foreground">
            {t("web.myClasses.reschedule.noTimeWorksHint")}
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}

function localYmd(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Shift a YYYY-MM-DD calendar date by whole days. Pure calendar math in
// UTC, so it's immune to DST shifts in the teacher's timezone.
function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
