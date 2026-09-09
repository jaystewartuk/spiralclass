import Link from "next/link";
import { Clock } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { toYMD, zonedWallClockToUtc } from "@/lib/tz";
import { monthOf, parseMonthParam } from "@/lib/calendar-grid";
import { BlockedDatesManager } from "./blocked-dates-manager";

/**
 * Blocked dates — the days the teacher is not teaching.
 *
 * The server's whole job here is to resolve instants into CALENDAR DAYS in the
 * teacher's own zone, once, and hand those down as plain `YYYY-MM-DD` strings.
 * Every date decision below the fold is then string comparison, so the grid,
 * the date fields and the list cannot end up disagreeing about which day it
 * is — which is the failure mode a client-side `new Date()` on this screen
 * would reintroduce the first time a teacher opened it near midnight.
 */
export default async function BlockedDatesPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();
  const tz = teacher.timezone;
  const todayYmd = toYMD(new Date(), tz);
  // From the first of the CURRENT month, not from now: a block that ended
  // earlier this month is still drawn on the month the screen opens on, and
  // leaving it out made the grid claim days were free that had not been.
  const monthStart = zonedWallClockToUtc(`${todayYmd.slice(0, 7)}-01`, "00:00", tz);
  // The earliest instant a block created from this screen can reach. The grid
  // refuses a past day, so a block always starts at today's local midnight —
  // and the collision query cancels by interval overlap, which reaches back to
  // a class that began yesterday evening and runs past it.
  const earliestBlockable = zonedWallClockToUtc(todayYmd, "00:00", tz);

  const [rows, bookings] = await Promise.all([
    prisma.blockedDate.findMany({
      where: { teacherId: teacher.id, endsAt: { gte: monthStart } },
      orderBy: { startsAt: "asc" },
    }),
    // What a new block would cancel — the same set, on the same overlap rule,
    // that `notifyBookingsInBlockedRange` will act on, so the number the
    // teacher is warned with is the number she gets. Bounded by the booking
    // window rather than by a `take`: an undercount here is an undercount in a
    // warning about something with no undo.
    prisma.booking.findMany({
      where: {
        teacherId: teacher.id,
        status: "scheduled",
        scheduledEnd: { gt: earliestBlockable },
      },
      select: { scheduledStart: true, scheduledEnd: true },
      orderBy: { scheduledStart: "asc" },
    }),
  ]);

  const blocks = rows.map((row) => ({
    id: row.id,
    start: toYMD(row.startsAt, tz),
    end: toYMD(row.endsAt, tz),
    reason: row.reason,
  }));
  // A class is stored as an instant pair; the days it OCCUPIES are what a
  // whole-day block collides with, and a class running past midnight occupies
  // two. That set is exactly what the server cancels by interval overlap, so
  // the count the teacher is warned with is the count she gets.
  const classSpans = bookings.map((b) => ({
    start: toYMD(b.scheduledStart, tz),
    end: toYMD(b.scheduledEnd, tz),
  }));

  // `?m=YYYY-MM` still opens on a chosen month; paging is client state from
  // there, so stepping through the year no longer costs a server round-trip.
  const params = await searchParams;
  const initial = parseMonthParam(params.m) ?? monthOf(todayYmd);

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("web.settings.blockedDates.title")}
        description={t("web.settings.blockedDates.body")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/availability">
              <Clock className="size-4" aria-hidden />
              {t("web.settings.blockedDates.workingHoursLink")}
            </Link>
          </Button>
        }
      />

      <BlockedDatesManager
        tz={tz}
        todayYmd={todayYmd}
        initialYear={initial.year}
        initialMonth0={initial.month0}
        blocks={blocks}
        classSpans={classSpans}
      />
    </div>
  );
}
