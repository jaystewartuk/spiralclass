import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/auth";
import { generateSlots } from "@/lib/slots";
import { loadGoogleBusyBlocks } from "@/lib/calendar/google/busy";
import { formatZonedDate, formatZonedTime, bookingWhen } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { studentIdentityIds } from "@/lib/students/identity";
import { summarizeCreditPools } from "@/lib/booking/credit-ledger";
import { addCalendarDays, firstAvailableDay } from "@/lib/booking/next-available";
import { buildMonthGrid, firstOfMonth, monthOf, monthStr, shiftMonth } from "@/lib/calendar-grid";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BookingMonthCalendar } from "@/components/calendar/booking-month-calendar";
import { HardLink } from "@/components/calendar/hard-link";
import { SlotSubmitButton } from "./slot-submit-button";

// Default to today's local date in the teacher's timezone.
function todayInZone(tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function clampYmd(ymd: string, min: string, max: string): string {
  if (ymd < min) return min;
  if (ymd > max) return max;
  return ymd;
}

export default async function ReservarPage({
  searchParams,
}: {
  searchParams: Promise<{ packageId?: string; date?: string }>;
}) {
  const student = await requireStudent();
  const params = await searchParams;
  const locale = await getPreferredLocale();
  const t = await getT();

  const bookablePackages = await prisma.package.findMany({
    where: {
      studentId: { in: await studentIdentityIds(student) },
      status: "active",
      classesUsed: { lt: prisma.package.fields.classesTotal },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: { teacher: true },
    orderBy: { purchasedAt: "desc" },
  });

  if (bookablePackages.length === 0) {
    // No bookable package: this is a high-intent moment, so instead of a
    // silent bounce back to the dashboard we explain why and point straight
    // at the in-portal purchase flow.
    return (
      <PageShell width="reading">
        <div>
          <Link href="/my-classes" className="text-sm underline">
            {t("web.myClasses.backToMyClasses")}
          </Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("book.title")}</CardTitle>
            <CardDescription>{t("web.myClasses.book.needActivePackage")}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t("web.myClasses.book.onceActiveHint")}
            </p>
          </CardContent>
          <CardFooter>
            <Button asChild>
              <Link href="/my-classes/buy">{t("web.myClasses.book.buyAPackage")}</Link>
            </Button>
          </CardFooter>
        </Card>
      </PageShell>
    );
  }

  // Collapse the packages into one spendable balance per (teacher, class
  // length). The student no longer picks an individual package — the server
  // always spends the soonest-to-expire credit in the chosen pool — so the UI
  // shows combined balances and the form submits a pool pointer.
  const pools = summarizeCreditPools(bookablePackages);
  const teacherById = new Map(bookablePackages.map((p) => [p.teacherId, p.teacher]));
  const referenced = bookablePackages.find((p) => p.id === params.packageId);
  const selectedPool =
    (referenced
      ? pools.find(
          (pl) =>
            pl.teacherId === referenced.teacherId &&
            pl.classDurationMin === referenced.classDurationMin,
        )
      : undefined) ?? pools[0];
  const teacher = teacherById.get(selectedPool.teacherId)!;
  const classDurationMin = selectedPool.classDurationMin;

  // Bookable window: from today through maxAdvanceDays, in the teacher's zone.
  const todayYmd = todayInZone(teacher.timezone);
  const maxYmd = addCalendarDays(todayYmd, teacher.maxAdvanceDays);

  // One burst for the whole bookable window (not just the visible month): the
  // auto-land search below can cross a month boundary, and generateSlots filters
  // its inputs by date internally so the wider arrays are also safe to reuse for
  // the visible-month calendar (slot generation inputs).
  const windowStartUtc = new Date(`${todayYmd}T00:00:00Z`);
  const windowEndUtc = new Date(`${maxYmd}T00:00:00Z`);

  const [rules, blocked, googleBusy, bookings] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { teacherId: teacher.id } }),
    prisma.blockedDate.findMany({
      where: {
        teacherId: teacher.id,
        endsAt: { gt: new Date(windowStartUtc.getTime() - 24 * 3600_000) },
        startsAt: { lt: new Date(windowEndUtc.getTime() + 48 * 3600_000) },
      },
    }),
    // Google busy-import (Phase 3): empty unless the teacher connected Google.
    loadGoogleBusyBlocks(teacher.id, prisma),
    prisma.booking.findMany({
      where: {
        teacherId: teacher.id,
        status: "scheduled",
        scheduledStart: {
          gte: new Date(windowStartUtc.getTime() - 24 * 3600_000),
          lt: new Date(windowEndUtc.getTime() + 48 * 3600_000),
        },
      },
      select: { scheduledStart: true, scheduledEnd: true, bufferMinSnapshot: true },
    }),
  ]);

  const slotTeacher = {
    timezone: teacher.timezone,
    bufferMin: teacher.bufferMin,
    minAdvanceH: teacher.minAdvanceH,
    maxAdvanceDays: teacher.maxAdvanceDays,
  };
  const blockedDates = [...blocked, ...googleBusy];
  const now = new Date();

  const slotsForDay = (ymd: string) =>
    generateSlots({
      date: ymd,
      classDurationMin,
      teacher: slotTeacher,
      availabilityRules: rules,
      blockedDates,
      existingBookings: bookings,
      now,
    });

  // Which day to show. An explicit ?date is the student's choice (clamped into
  // the window). With no explicit date she's just landed, so instead of parking
  // her on an empty "today" we auto-land on the first available day across the
  // whole window. Falls back to today when the window
  // is entirely empty (the calendar arrows still let her browse later months).
  const date = params.date
    ? clampYmd(params.date, todayYmd, maxYmd)
    : (firstAvailableDay(todayYmd, maxYmd, (d) => slotsForDay(d).length > 0) ?? todayYmd);

  // The visible month is the one containing the selected day.
  const { year, month0 } = monthOf(date);
  const grid = buildMonthGrid(year, month0);

  // Compute availability for every day in the visible grid (within the bookable
  // window) so the calendar can dot the open days; capture the selected day's
  // slots in the same pass.
  const availableDays = new Set<string>();
  let selectedSlots: ReturnType<typeof generateSlots> = [];
  for (const g of grid) {
    if (g.ymd < todayYmd || g.ymd > maxYmd) continue;
    const daySlots = slotsForDay(g.ymd);
    if (daySlots.length > 0) availableDays.add(g.ymd);
    if (g.ymd === date) selectedSlots = daySlots;
  }

  // Month navigation: keep the selected day inside the bookable window. Prev is
  // disabled once the visible month is the current one; next once the month
  // starts beyond maxAdvanceDays.
  const visibleMonthStr = monthStr(year, month0);
  const todayMonthStr = monthStr(monthOf(todayYmd).year, monthOf(todayYmd).month0);
  const prev = shiftMonth(year, month0, -1);
  const next = shiftMonth(year, month0, 1);
  const nextMonthFirst = firstOfMonth(next.year, next.month0);
  const linkBase = `/my-classes/book?packageId=${selectedPool.referencePackageId}`;
  const dayHref = (ymd: string) => `${linkBase}&date=${ymd}`;
  const prevHref =
    visibleMonthStr > todayMonthStr
      ? dayHref(clampYmd(firstOfMonth(prev.year, prev.month0), todayYmd, maxYmd))
      : null;
  const nextHref = nextMonthFirst <= maxYmd ? dayHref(nextMonthFirst) : null;

  // Within-grid "jump to the next open day" for when the selected day is empty.
  const nextAvailableDate =
    selectedSlots.length === 0
      ? ([...availableDays].filter((d) => d >= date).sort()[0] ?? null)
      : null;
  const nextAvailableDisplay = nextAvailableDate
    ? formatZonedDate(new Date(`${nextAvailableDate}T12:00:00Z`), teacher.timezone, locale)
    : null;

  const dateDisplay = new Date(`${date}T12:00:00Z`);

  return (
    <PageShell width="reading">
      <div>
        <Link href="/my-classes" className="text-sm underline">
          {t("web.myClasses.backToMyClasses")}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("book.title")}</CardTitle>
          <CardDescription>
            {t("web.myClasses.book.pickDayAndTime", { timezone: teacher.timezone })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {pools.length > 1 && (
            <div>
              <p className="mb-2 text-sm font-medium">{t("web.myClasses.book.balance")}</p>
              <div className="flex flex-wrap gap-2">
                {pools.map((pl) => {
                  const poolTeacher = teacherById.get(pl.teacherId)!;
                  const active =
                    pl.teacherId === selectedPool.teacherId &&
                    pl.classDurationMin === selectedPool.classDurationMin;
                  return (
                    <HardLink
                      key={`${pl.teacherId}:${pl.classDurationMin}`}
                      href={`/my-classes/book?packageId=${pl.referencePackageId}&date=${date}`}
                      className={`rounded-md border px-3 py-1 text-sm ${
                        active ? "border-primary bg-primary/10" : ""
                      }`}
                    >
                      {pl.classDurationMin} min · {poolTeacher.name} · {pl.classesLeft}
                    </HardLink>
                  );
                })}
              </div>
            </div>
          )}

          <p className="text-sm text-muted-foreground">
            {selectedPool.classesLeft === 1
              ? t("web.myClasses.book.classLeftOneWith", { name: teacher.name })
              : t("web.myClasses.book.classesLeftWith", {
                  n: selectedPool.classesLeft,
                  name: teacher.name,
                })}
            {selectedPool.nextExpiresAt
              ? t("web.myClasses.book.soonestExpires", {
                  date: formatZonedDate(selectedPool.nextExpiresAt, teacher.timezone, locale),
                })
              : ""}
          </p>

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

          <div className="border-t pt-4">
            <p className="mb-3 text-sm font-medium capitalize">
              {formatZonedDate(dateDisplay, teacher.timezone, locale)}
            </p>

            {selectedSlots.length === 0 ? (
              <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-4 text-center">
                <p className="text-sm text-muted-foreground">{t("book.empty")}</p>
                {nextAvailableDate ? (
                  <Button
                    asChild
                    className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-center lg:min-h-10"
                  >
                    <HardLink href={dayHref(nextAvailableDate)}>
                      {t("web.myClasses.book.goToNextAvailableDay", {
                        date: nextAvailableDisplay ?? "",
                      })}
                    </HardLink>
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("web.myClasses.book.noTimesLeftThisMonth")}
                  </p>
                )}
              </div>
            ) : (
              <ul className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                {selectedSlots.map((s) => (
                  <li key={s.startUtc.toISOString()}>
                    <SlotSubmitButton
                      packageId={selectedPool.referencePackageId}
                      startUtc={s.startUtc.toISOString()}
                      label={formatZonedTime(
                        s.startUtc,
                        student.timezone ?? teacher.timezone,
                        locale,
                      )}
                      summary={(() => {
                        const w = bookingWhen(
                          s.startUtc,
                          student.timezone ?? teacher.timezone,
                          { tz: teacher.timezone, label: teacher.name },
                          locale,
                          t,
                        );
                        return `${w.when} · ${w.whenSecondary}`;
                      })()}
                      subtitle={`${classDurationMin} min · ${teacher.name}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
