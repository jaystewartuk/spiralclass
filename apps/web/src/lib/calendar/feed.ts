import type { BookingStatus } from "@prisma/client";
import {
  getDualZoneTime,
  createT,
  matchAcceptLanguage,
  DEFAULT_LOCALE,
  type AppLocale,
  type TFunction,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { buildVcalendar, type IcsEvent } from "@/lib/calendar/ics";
import type { FeedOwner } from "@/lib/calendar/feed-token";

// Dual-timezone display standard: a calendar client localises DTSTART/DTEND
// to the SUBSCRIBER's own device zone automatically (that's the whole reason
// this feed emits bare UTC instants, no VTIMEZONE — see ics.ts). ICS has no
// native way to show a second zone alongside that, so the other
// participant's local time is appended to the event description instead —
// the only field a calendar app renders as free text.
function otherPartyIcsLine(
  start: Date,
  viewerTz: string,
  other: { tz: string; name: string },
  locale: AppLocale,
): string {
  const dz = getDualZoneTime(
    start,
    { tz: viewerTz, label: "" },
    { tz: other.tz, label: other.name },
    locale,
  );
  const time = `${dz.other.dateLabel}, ${dz.other.timeLabel} (${dz.other.tzDisplay})`;
  return createT(locale)("web.dualZone.otherPartyTime", { name: other.name, time });
}

// Builds the subscribable iCal feed for a teacher or student. Emits UTC
// instants only, so no timezone handling is needed here. A wide window keeps a
// little history and ~a year ahead; cancelled/rescheduled classes are emitted
// as STATUS:CANCELLED so a synced client drops them on the next poll.

const PAST_WINDOW_MS = 60 * 24 * 60 * 60 * 1000; // 60 days back
const FUTURE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000; // ~1 year ahead
const REFRESH = "PT12H";

function isCancelledStatus(status: BookingStatus): boolean {
  return (
    status === "canceled_by_student" || status === "canceled_by_teacher" || status === "rescheduled"
  );
}

// The feed is read by a calendar app with no session, so the language is the
// owner's stored locale. This was `isEnglish()`, which gave every other
// locale — French included — the Spanish feed.
function feedLocale(locale: string | null | undefined): AppLocale {
  return matchAcceptLanguage(locale) ?? DEFAULT_LOCALE;
}

export async function buildCalendarFeed(
  owner: FeedOwner,
  opts: { appUrl: string; now?: Date },
): Promise<{ ics: string; calName: string }> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - PAST_WINDOW_MS);
  const to = new Date(now.getTime() + FUTURE_WINDOW_MS);
  const appUrl = opts.appUrl.replace(/\/$/, "");

  if (owner.kind === "teacher") {
    // The locale lookup and the bookings query are independent — run them
    // concurrently rather than one after the other (this feed is polled
    // repeatedly by every subscribed calendar client).
    const [teacher, bookings] = await Promise.all([
      prisma.teacher.findUnique({
        where: { id: owner.id },
        select: { locale: true, timezone: true },
      }),
      prisma.booking.findMany({
        where: { teacherId: owner.id, scheduledStart: { gte: from, lte: to } },
        orderBy: { scheduledStart: "asc" },
        include: { student: { select: { name: true, timezone: true } } },
      }),
    ]);
    const locale = feedLocale(teacher?.locale);
    const t = createT(locale);
    const calName = t("calendarFeed.calName");
    const teacherTz = teacher?.timezone ?? "UTC";

    const events = bookings.map((b) =>
      toIcsEvent({
        id: b.id,
        start: b.scheduledStart,
        end: b.scheduledEnd,
        status: b.status,
        summary: t("web.dashboard.classes.calendarEventTitle", { name: b.student.name }),
        url: `${appUrl}/dashboard/classes/${b.id}`,
        t,
        otherPartyLine: otherPartyIcsLine(
          b.scheduledStart,
          teacherTz,
          {
            tz: b.student.timezone ?? teacherTz,
            name: b.student.name,
          },
          locale,
        ),
      }),
    );
    return { ics: buildVcalendar(events, { name: calName, refresh: REFRESH }), calName };
  }

  // Student: aggregate across every teacher in their identity set.
  const student = await prisma.student.findUnique({
    where: { id: owner.id },
    select: { id: true, email: true, locale: true, timezone: true },
  });
  const locale = feedLocale(student?.locale);
  const t = createT(locale);
  const calName = t("calendarFeed.calName");
  if (!student) return { ics: buildVcalendar([], { name: calName, refresh: REFRESH }), calName };

  const studentIds = await studentIdentityIds(student);
  const bookings = await prisma.booking.findMany({
    where: { studentId: { in: studentIds }, scheduledStart: { gte: from, lte: to } },
    orderBy: { scheduledStart: "asc" },
    include: { teacher: { select: { name: true, timezone: true } } },
  });

  const events = bookings.map((b) => {
    const viewerTz = student.timezone ?? b.teacher.timezone;
    return toIcsEvent({
      id: b.id,
      start: b.scheduledStart,
      end: b.scheduledEnd,
      status: b.status,
      summary: t("web.myClasses.confirmation.calendarTitle", { name: b.teacher.name }),
      url: `${appUrl}/my-classes/${b.id}`,
      t,
      otherPartyLine: otherPartyIcsLine(
        b.scheduledStart,
        viewerTz,
        {
          tz: b.teacher.timezone,
          name: b.teacher.name,
        },
        locale,
      ),
    });
  });
  return { ics: buildVcalendar(events, { name: calName, refresh: REFRESH }), calName };
}

function toIcsEvent(input: {
  id: string;
  start: Date;
  end: Date;
  status: BookingStatus;
  summary: string;
  url: string;
  t: TFunction;
  otherPartyLine: string;
}): IcsEvent {
  const base = input.t("calendarFeed.bookedThrough");
  return {
    uid: `booking-${input.id}@spiralclass.com`,
    start: input.start,
    end: input.end,
    summary: input.summary,
    description: `${base}\n${input.otherPartyLine}`,
    url: input.url,
    status: isCancelledStatus(input.status) ? "CANCELLED" : "CONFIRMED",
  };
}
