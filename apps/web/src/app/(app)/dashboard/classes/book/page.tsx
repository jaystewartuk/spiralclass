import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarPlus, Mail, PackageOpen } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { BookingMonthCalendar } from "@/components/calendar/booking-month-calendar";
import { HardLink } from "@/components/calendar/hard-link";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateSlots, type Slot } from "@/lib/slots";
import { loadGoogleBusyBlocks } from "@/lib/calendar/google/busy";
import {
  bookingWhen,
  capitalizeFirst,
  formatZonedDate,
  formatZonedTime,
  timezoneCityLabel,
} from "@/lib/date-display";
import { getDualZoneTime, minutesOfDayInTz } from "@spiralclass/shared";
import { getPreferredLocale, getT, type AppLocale } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { classesLeftToTeach } from "@/lib/package-usage";
import { toYMD } from "@/lib/tz";
import { addCalendarDays, firstAvailableDay } from "@/lib/booking/next-available";
import {
  bookHref,
  filterRoster,
  groupSlotsByDayPart,
  normalizeRosterSearch,
  orderRoster,
  resolveBookableDay,
  type DayPart,
  type RosterEntry,
} from "@/lib/booking/teacher-book";
import {
  buildMonthGrid,
  firstOfMonth,
  monthOf,
  monthStr,
  shiftMonth,
  ymdToUtcNoon,
} from "@/lib/calendar-grid";
import { initialsFrom } from "@/lib/initials";
import { cn } from "@/lib/utils";
import { StudentPicker } from "./student-picker";
import { TeacherSlotButton } from "./teacher-slot-button";

/**
 * Teacher self-serve booking: put a class on the calendar for a student who
 * agreed it somewhere else (which, in practice, is WhatsApp).
 *
 * THREE STEPS, THREE URLs — pick a student, pick one of her packages, pick a
 * time. Every step is a query parameter on this one route and the whole screen
 * is server-rendered, so the back button, a bookmark and a middle-click all
 * work and none of it costs client JavaScript. That part predates this pass
 * and is kept deliberately.
 *
 * WHAT CHANGED, and why each was a decision rather than a preference:
 *
 *  1. THE PAGE HAS AN `h1`. The title was a `CardTitle`, which renders an
 *     `h3`, so this screen had no top-level heading at all and a screen reader
 *     started its outline at level three. `PageHeader` is what every other
 *     screen uses and it is what this uses now.
 *  2. THE DAY IT OPENS ON IS A DAY WITH TIMES IN IT. It opened on today, and
 *     a teacher reaching for this in the evening got an empty grid as her
 *     first impression of the feature. The student flow already lands on the
 *     first open day; this now does the same, over the same window.
 *  3. "NEXT AVAILABLE" LOOKS PAST THE MONTH. Availability was only ever
 *     computed for the visible six-week grid, so the fallback could not see
 *     into next month and said "No times left this month" while the 14th of
 *     the next one was open. Both the landing search and the jump now run over
 *     the whole bookable window.
 *  4. THE STUDENT'S OWN CLOCK IS ON THE BUTTON. This product is explicitly not
 *     one country (see CLAUDE.md), so a teacher booking on a student's behalf
 *     is routinely booking into another zone — and the only place her time
 *     appeared was inside the confirmation dialog, which is reached by
 *     tapping the time you already chose.
 *  5. THE CALENDAR AND THE TIMES SIT SIDE BY SIDE above `lg`. They were
 *     stacked in a 66-character reading column, which is the right column for
 *     prose and the wrong one for a month grid — it left the times a scroll
 *     below the fold on a laptop.
 *
 * Tenancy: the student link, the packages and every availability query
 * are scoped by `teacherId` from `requireOnboardedTeacher`. The slot grid
 * bypasses the teacher's own `minAdvanceH` (she is confirming an already-agreed
 * class) but honours availability windows, blocked dates and collisions — the
 * same split the action enforces server-side in `bookPackageSlot`.
 */

/** Padding around the window's edges so a slot on day one or day N sees its neighbours. */
const LEAD_MS = 24 * 3600_000;
const TRAIL_MS = 48 * 3600_000;

export default async function TeacherBookPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [teacher, params, locale, t] = await Promise.all([
    requireOnboardedTeacher(),
    searchParams,
    getPreferredLocale(),
    getT(),
  ]);

  const studentId = typeof params.studentId === "string" ? params.studentId : undefined;
  const packageId = typeof params.packageId === "string" ? params.packageId : undefined;
  const rawDate = typeof params.date === "string" ? params.date : undefined;

  const now = new Date();
  const todayYmd = toYMD(now, teacher.timezone);
  const maxYmd = addCalendarDays(todayYmd, teacher.maxAdvanceDays);
  // Validated here, once, before it is put back into any link: the old page
  // carried the raw parameter through the student picker into an href.
  const carriedDate = resolveBookableDay(rawDate, todayYmd, maxYmd) ?? undefined;

  // ── Step 1: pick a student ──────────────────────────────────────────────
  if (!studentId) {
    const query = normalizeRosterSearch(params.q);
    const [links, openPackages] = await Promise.all([
      prisma.teacherStudent.findMany({
        where: { teacherId: teacher.id, archivedAt: null },
        include: { student: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
      }),
      // Every package this teacher could still book against, in one query
      // rather than one per student. Bounded by her own package count, and it
      // is the fact the list is picked from — see StudentPicker.
      prisma.package.findMany({
        where: {
          teacherId: teacher.id,
          status: "active",
          classesUsed: { lt: prisma.package.fields.classesTotal },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { studentId: true, classesTotal: true, classesUsed: true },
      }),
    ]);

    const availableByStudent = new Map<string, number>();
    for (const pkg of openPackages) {
      availableByStudent.set(
        pkg.studentId,
        (availableByStudent.get(pkg.studentId) ?? 0) + classesLeftToTeach({ ...pkg, scheduled: 0 }),
      );
    }

    const roster: RosterEntry[] = links.map((l) => ({
      studentId: l.student.id,
      name: l.student.name,
      email: l.student.email,
      classesAvailable: availableByStudent.get(l.student.id) ?? 0,
      sortDate: l.createdAt,
    }));

    return (
      <BookShell t={t} width="default" description={t("web.dashboard.classes.pickStudent")}>
        <StudentPicker
          entries={orderRoster(filterRoster(roster, query))}
          query={query}
          totalCount={roster.length}
          date={carriedDate}
          t={t}
        />
      </BookShell>
    );
  }

  // Confirm the student is on this teacher's roster (tenant isolation).
  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
    include: { student: { select: { id: true, name: true, email: true, timezone: true } } },
  });
  if (!link) notFound();
  const studentName = link.student.name;

  // ── Step 2: pick a package ──────────────────────────────────────────────
  const bookablePackages = await prisma.package.findMany({
    where: {
      teacherId: teacher.id,
      studentId,
      status: "active",
      classesUsed: { lt: prisma.package.fields.classesTotal },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { template: { select: { name: true } } },
    orderBy: { purchasedAt: "desc" },
  });

  if (bookablePackages.length === 0) {
    return (
      <BookShell t={t} width="default" description={studentName}>
        <EmptyState
          icon={PackageOpen}
          title={t("teacherBook.noPackages")}
          description={t("web.dashboard.classes.noBookablePackage")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild size="sm">
                <Link href={`/dashboard/students/${studentId}`}>
                  {t("web.dashboard.classes.goToStudentPage")}
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={bookHref({ date: carriedDate })}>
                  {t("web.dashboard.classes.book.pickAnotherStudent")}
                </Link>
              </Button>
            </div>
          }
        />
      </BookShell>
    );
  }

  const selected = bookablePackages.find((p) => p.id === packageId) ?? bookablePackages[0];

  // ── Step 3: pick a day and a time ───────────────────────────────────────
  const slotTeacher = {
    timezone: teacher.timezone,
    bufferMin: teacher.bufferMin,
    // She is confirming an already-agreed class; the action bypasses the same
    // rule server-side, so offering a slot inside her lead time is honest.
    minAdvanceH: 0,
    maxAdvanceDays: teacher.maxAdvanceDays,
  };

  // ONE burst for the whole bookable window, not the visible month: the
  // landing search and the "next available" jump both cross month boundaries,
  // and `generateSlots` filters its inputs by date internally, so the wider
  // arrays are equally safe to reuse for the visible grid.
  // MIDNIGHT UTC, not noon: these are the outer bounds of the collision
  // queries, and a teacher at UTC+14 begins `todayYmd` at 10:00Z on the day
  // BEFORE it. Anchoring at midnight keeps the existing 24h/48h padding a real
  // margin in every zone rather than a 12-hour-shorter one at the eastern end.
  const windowStartUtc = new Date(`${todayYmd}T00:00:00.000Z`);
  const windowEndUtc = new Date(`${maxYmd}T00:00:00.000Z`);

  const [rules, blocked, googleBusy, bookings] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { teacherId: teacher.id } }),
    prisma.blockedDate.findMany({
      where: {
        teacherId: teacher.id,
        endsAt: { gt: new Date(windowStartUtc.getTime() - LEAD_MS) },
        startsAt: { lt: new Date(windowEndUtc.getTime() + TRAIL_MS) },
      },
    }),
    // Google busy-import (Phase 3): empty unless the teacher connected Google.
    loadGoogleBusyBlocks(teacher.id, prisma),
    prisma.booking.findMany({
      where: {
        teacherId: teacher.id,
        status: "scheduled",
        scheduledStart: {
          gte: new Date(windowStartUtc.getTime() - LEAD_MS),
          lt: new Date(windowEndUtc.getTime() + TRAIL_MS),
        },
      },
      select: { scheduledStart: true, scheduledEnd: true, bufferMinSnapshot: true },
    }),
  ]);

  const blockedDates = [...blocked, ...googleBusy];

  // Memoised, because up to three passes ask about overlapping day ranges —
  // the landing search, the visible grid, and the forward jump — and
  // `generateSlots` is pure, so the second question about a day is free.
  const cache = new Map<string, Slot[]>();
  const slotsForDay = (ymd: string): Slot[] => {
    const hit = cache.get(ymd);
    if (hit) return hit;
    const computed = generateSlots({
      date: ymd,
      classDurationMin: selected.classDurationMin,
      teacher: slotTeacher,
      availabilityRules: rules,
      blockedDates,
      existingBookings: bookings,
      now,
    });
    cache.set(ymd, computed);
    return computed;
  };
  const hasSlots = (ymd: string) => slotsForDay(ymd).length > 0;

  // An explicit `?date` is her choice. With none she has just arrived, so open
  // on the first day that actually has times rather than on an empty today.
  const date =
    resolveBookableDay(rawDate, todayYmd, maxYmd) ??
    firstAvailableDay(todayYmd, maxYmd, hasSlots) ??
    todayYmd;

  const { year, month0 } = monthOf(date);
  const grid = buildMonthGrid(year, month0);
  const availableDays = new Set<string>();
  for (const g of grid) {
    if (g.ymd < todayYmd || g.ymd > maxYmd) continue;
    if (hasSlots(g.ymd)) availableDays.add(g.ymd);
  }
  const slots = slotsForDay(date);

  const dayHref = (d: string) => bookHref({ studentId, packageId: selected.id, date: d });

  // Month navigation, clamped to the bookable window at both ends.
  const visibleMonthStr = monthStr(year, month0);
  const todayMonthStr = monthStr(monthOf(todayYmd).year, monthOf(todayYmd).month0);
  const prev = shiftMonth(year, month0, -1);
  const next = shiftMonth(year, month0, 1);
  const nextMonthFirst = firstOfMonth(next.year, next.month0);
  const prevHref =
    visibleMonthStr > todayMonthStr
      ? dayHref(
          resolveBookableDay(firstOfMonth(prev.year, prev.month0), todayYmd, maxYmd) ?? todayYmd,
        )
      : null;
  const nextHref = nextMonthFirst <= maxYmd ? dayHref(nextMonthFirst) : null;

  // The forward jump, over the whole window rather than the visible grid.
  const nextAvailableDate = slots.length === 0 ? firstAvailableDay(date, maxYmd, hasSlots) : null;

  const zoneLabel = timezoneCityLabel(teacher.timezone);
  const studentTz = link.student.timezone;
  const crossZone = Boolean(studentTz && studentTz !== teacher.timezone);
  const available = classesLeftToTeach({ ...selected, scheduled: 0 });

  return (
    <BookShell
      t={t}
      width="wide"
      description={t("web.dashboard.classes.timesInZone", { tz: zoneLabel })}
    >
      <BookingContext
        studentId={studentId}
        studentName={studentName}
        studentEmail={link.student.email}
        packages={bookablePackages.map((p) => ({
          id: p.id,
          name: p.template?.name ?? t("web.dashboard.classes.book.package"),
          available: classesLeftToTeach({ ...p, scheduled: 0 }),
          total: p.classesTotal,
        }))}
        selectedPackageId={selected.id}
        selectedLabel={t("web.dashboard.classes.book.packageUsage", {
          available,
          total: selected.classesTotal,
        })}
        selectedName={selected.template?.name ?? t("web.dashboard.classes.book.package")}
        date={date}
        t={t}
      />

      {/* One object, two panes: a month on the left, its times on the right.
          They stack below `lg`, calendar first, which is also the order the
          decision is made in. */}
      <Card className="overflow-hidden">
        <div className="lg:grid lg:grid-cols-5">
          <section aria-labelledby="book-day" className="p-4 lg:col-span-2 lg:p-6">
            <h2 id="book-day" className="mb-4 font-semibold">
              {t("web.dashboard.classes.book.pickDay")}
            </h2>
            <BookingMonthCalendar
              year={year}
              month0={month0}
              selectedYmd={date}
              todayYmd={todayYmd}
              minYmd={todayYmd}
              maxYmd={maxYmd}
              availableDays={availableDays}
              locale={locale}
              dayHref={dayHref}
              prevHref={prevHref}
              nextHref={nextHref}
            />
          </section>

          <section
            aria-labelledby="book-times"
            className="border-t border-border p-4 lg:col-span-3 lg:border-l lg:border-t-0 lg:p-6"
          >
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              {/* Capitalised in JS, not by `capitalize`: that utility
                  title-cases every word, so the Spanish rendering of this
                  exact string came out "Jueves, 12 De Junio De 2026". */}
              <h2 id="book-times" className="font-semibold">
                {capitalizeFirst(
                  formatZonedDate(ymdToUtcNoon(date), teacher.timezone, locale),
                  locale,
                )}
              </h2>
              {slots.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("web.dashboard.classes.book.slotCount", { count: slots.length })}
                </p>
              )}
            </div>

            {crossZone && studentTz && (
              <p className="mb-4 text-sm text-muted-foreground">
                {t("web.dashboard.classes.book.studentZoneNote", {
                  name: studentName,
                  tz: timezoneCityLabel(studentTz),
                })}
              </p>
            )}

            {slots.length === 0 ? (
              <EmptyDay
                nextAvailableDate={nextAvailableDate}
                nextAvailableHref={nextAvailableDate ? dayHref(nextAvailableDate) : null}
                nextAvailableLabel={
                  nextAvailableDate
                    ? formatZonedDate(ymdToUtcNoon(nextAvailableDate), teacher.timezone, locale)
                    : ""
                }
                windowEndLabel={formatZonedDate(ymdToUtcNoon(maxYmd), teacher.timezone, locale)}
                t={t}
              />
            ) : (
              <SlotGroups
                slots={slots}
                teacherTimezone={teacher.timezone}
                studentTimezone={crossZone ? studentTz : null}
                studentName={studentName}
                packageId={selected.id}
                classDurationMin={selected.classDurationMin}
                locale={locale}
                now={now}
                t={t}
              />
            )}

            {/* The question a teacher booking on someone else's behalf actually
                has, answered where she is about to act on it rather than in a
                help article: yes, they are told. Only beside times she can
                pick — on an empty day it is a promise about nothing. */}
            {slots.length > 0 && (
              <p className="mt-6 flex items-start gap-2 border-t pt-4 text-sm text-muted-foreground">
                <Mail className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {t("web.dashboard.classes.book.whenYouBookBody", { name: studentName })}
                </span>
              </p>
            )}
          </section>
        </div>
      </Card>
    </BookShell>
  );
}

/**
 * The chrome every step shares: one `h1`, one description, one way back.
 *
 * `width` differs by step on purpose. A roster is a list of names — a reading
 * column — while the day-and-time step is a calendar beside a grid and needs
 * the room. Below `lg` both are the same single column anyway.
 */
function BookShell({
  t,
  width,
  description,
  children,
}: {
  t: TFunction;
  width: "default" | "wide";
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <PageShell width={width}>
      <PageHeader
        title={t("teacherBook.title")}
        description={description}
        actions={
          <Button asChild variant="outline">
            <Link href="/dashboard/classes">
              <ArrowLeft className="size-4" aria-hidden />
              {t("web.dashboard.classes.backToClasses")}
            </Link>
          </Button>
        }
      />
      {children}
    </PageShell>
  );
}

/**
 * What has been decided so far, and how to undo it.
 *
 * The old screen put the student's name in the card title and offered no way
 * back to the picker — once she had chosen Marcela, changing to Sofía meant
 * leaving the flow and starting it again. A summary of the choices already
 * made, each still changeable, is the standard shape for a multi-step form and
 * costs one card.
 */
function BookingContext({
  studentId,
  studentName,
  studentEmail,
  packages,
  selectedPackageId,
  selectedName,
  selectedLabel,
  date,
  t,
}: {
  studentId: string;
  studentName: string;
  studentEmail: string | null;
  packages: Array<{ id: string; name: string; available: number; total: number }>;
  selectedPackageId: string;
  selectedName: string;
  selectedLabel: string;
  date: string;
  t: TFunction;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-4 lg:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 select-none items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground"
          >
            {initialsFrom(studentName, studentEmail)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-muted-foreground">
              {t("web.dashboard.classes.book.student")}
            </span>
            <span className="block truncate font-semibold">{studentName}</span>
          </span>
          <Button asChild variant="outline" size="sm">
            <Link
              href={bookHref({ date })}
              aria-label={t("web.dashboard.classes.book.pickAnotherStudent")}
            >
              {t("web.dashboard.classes.book.change")}
            </Link>
          </Button>
        </div>

        <div className="border-t pt-4">
          <p id="book-package" className="mb-2 text-sm text-muted-foreground">
            {t("web.dashboard.classes.book.package")}
          </p>
          {packages.length === 1 ? (
            <p className="text-sm">
              <span className="font-semibold">{selectedName}</span>
              <span className="text-muted-foreground"> · {selectedLabel}</span>
            </p>
          ) : (
            // Links, not a radio group: each one is a different server-rendered
            // state at its own URL, so it is navigation. `aria-current` carries
            // the selection — a `role="radiogroup"` would promise arrow-key
            // behaviour that nothing here implements.
            <div role="group" aria-labelledby="book-package" className="flex flex-wrap gap-2">
              {packages.map((p) => {
                const active = p.id === selectedPackageId;
                return (
                  <HardLink
                    key={p.id}
                    href={bookHref({ studentId, packageId: p.id, date })}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex min-h-target flex-col justify-center rounded-md border px-3 py-2 text-sm transition-colors",
                      // A SOLID selected state, not `bg-primary/10`: a tint
                      // composites against whatever is behind it, which is the
                      // defect `Badge` was migrated off (see badge.tsx).
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <span className="font-semibold">{p.name}</span>
                    <span className={active ? "text-primary-foreground" : "text-muted-foreground"}>
                      {t("web.dashboard.classes.book.packageUsage", {
                        available: p.available,
                        total: p.total,
                      })}
                    </span>
                  </HardLink>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A day's open times, banded into morning / afternoon / evening.
 *
 * The bands are a reading aid, not a filter — every slot is still on screen.
 * Twenty identical buttons in one grid are read by scanning all twenty; three
 * labelled runs of six are read by jumping to the one she was asked for.
 */
function SlotGroups({
  slots,
  teacherTimezone,
  studentTimezone,
  studentName,
  packageId,
  classDurationMin,
  locale,
  now,
  t,
}: {
  slots: Slot[];
  teacherTimezone: string;
  /** Null when the two zones agree — then no second line is drawn at all. */
  studentTimezone: string | null;
  studentName: string;
  packageId: string;
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

  // `minutesOfDayInTz` is the one helper in the codebase allowed to read an
  // hour out of a zone rather than print one (see
  // tests/config/time-format-consistency.test.ts) — which is exactly what
  // bucketing needs, and why this does not roll its own formatter.
  const groups = groupSlotsByDayPart(slots, (s) =>
    Math.floor(minutesOfDayInTz(s.startUtc, teacherTimezone) / 60),
  );

  return (
    <div className="space-y-5">
      {groups.map(({ part, slots: partSlots }) => (
        <section key={part} aria-labelledby={`book-part-${part}`}>
          <h3 id={`book-part-${part}`} className="mb-2 text-sm font-semibold text-muted-foreground">
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
              // date differs there — the rollover is the whole reason this
              // line exists, and it is the one part a bare time hides.
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
              return (
                <li key={s.startUtc.toISOString()}>
                  <TeacherSlotButton
                    packageId={packageId}
                    startUtc={s.startUtc.toISOString()}
                    label={timeLabel}
                    secondaryLabel={theirTime}
                    ariaLabel={
                      theirTime
                        ? `${t("web.dashboard.classes.bookAtTime", { time: timeLabel })}. ${t(
                            "web.dashboard.classes.book.theirTime",
                            { time: theirTime, name: studentName },
                          )}`
                        : t("web.dashboard.classes.bookAtTime", { time: timeLabel })
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

/**
 * A day with nothing open on it.
 *
 * Two different facts, said differently, because they call for different
 * actions: there is a next open day (jump to it), or the window is exhausted
 * from here on (her working hours are the thing to look at). The old screen
 * said "No times left this month" for both, which was false whenever the
 * emptiness was this month's alone.
 */
function EmptyDay({
  nextAvailableDate,
  nextAvailableHref,
  nextAvailableLabel,
  windowEndLabel,
  t,
}: {
  nextAvailableDate: string | null;
  nextAvailableHref: string | null;
  nextAvailableLabel: string;
  windowEndLabel: string;
  t: TFunction;
}) {
  return (
    <div className="rounded-md border bg-muted p-6 text-center">
      <CalendarPlus className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
      <p className="font-semibold">{t("book.empty")}</p>
      {nextAvailableDate && nextAvailableHref ? (
        <Button
          asChild
          className="mt-4 h-auto min-h-target max-w-full whitespace-normal py-2 text-center"
        >
          <HardLink href={nextAvailableHref}>
            {t("web.dashboard.classes.goToNextAvailableDay", { date: nextAvailableLabel })}
          </HardLink>
        </Button>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("web.dashboard.classes.book.noTimesInWindow", { date: windowEndLabel })}{" "}
          <Link href="/settings/availability" className="underline">
            {t("web.dashboard.classes.book.checkHours")}
          </Link>
          .
        </p>
      )}
    </div>
  );
}
