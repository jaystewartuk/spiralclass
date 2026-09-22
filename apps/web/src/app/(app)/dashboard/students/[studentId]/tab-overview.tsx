import Link from "next/link";
import type { Teacher } from "@prisma/client";
import { ArrowRight, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CallCta } from "@/components/call-cta";
import { prisma } from "@/lib/prisma";
import { formatZonedDateTime, getDualZoneTime, timezoneCityLabel } from "@/lib/date-display";
import { bookingStatusMeta } from "@/lib/booking/status-display";
import { profileSchema } from "@/lib/lesson-notes/profile";
import { skillLabel } from "@/lib/lesson-notes/skills";
import type { AppLocale, TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";
import { StudentNotes, type StudentNoteView } from "./student-notes-form";
import { studentDetailHref } from "./student-detail-nav";

/**
 * The pre-class briefing.
 *
 * A teacher opens a student two minutes before a lesson, and this is the view
 * she lands on. It answers, in reading order: is there a class to join right
 * now, what is coming, what happened last time, and what am I supposed to be
 * working on with this person. Nothing here is editable except the notes,
 * which are the one thing she writes DURING that two minutes.
 *
 * Two columns above `lg`, list on the left, briefing on the right — the same
 * split the classes screen uses, and the reason neither renders in a 672px
 * ribbon on a 1440px display.
 */

type ClassRowItem = {
  id: string;
  scheduledStart: Date;
  status: string;
};

/**
 * One class in a list.
 *
 * TWO THINGS ABOUT THE SECOND CLOCK. It is printed only when the two wall
 * clocks disagree — the rule the classes list already follows, and the reason
 * the old version of this page put a second line under every single row
 * including the ones that repeated the line above.
 *
 * And it names the CITY rather than the student. The shared
 * `web.dualZone.otherPartyTime` string is "{name}'s time: {time}", which is
 * right on the classes list, where every row is a different person. Here every
 * row is the same person, whose name is the page's own heading — so the name
 * is the half of the line carrying no information, and on a phone it was the
 * half that survived while the timezone got truncated away.
 */
function ClassRow({
  item,
  studentName,
  teacherTimezone,
  studentTimezone,
  locale,
  t,
  showStatus,
}: {
  item: ClassRowItem;
  studentName: string;
  teacherTimezone: string;
  studentTimezone: string;
  locale: AppLocale;
  t: TFunction;
  showStatus: boolean;
}) {
  const dz = getDualZoneTime(
    item.scheduledStart,
    { tz: teacherTimezone, label: t("web.dualZone.yourTime") },
    // The label is required by the formatter and deliberately unused in the
    // output — see the note above on why the city replaces the name here.
    { tz: studentTimezone, label: studentName },
    locale,
  );
  const status = bookingStatusMeta(item.status, "teacher", t);

  return (
    <li>
      <Link
        href={`/dashboard/classes/${item.id}`}
        className="flex min-h-11 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset lg:px-6"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">
            {dz.viewer.dateLabel}
            <span className="font-normal text-muted-foreground"> · </span>
            <span className="tabular-nums">{dz.viewer.timeLabel}</span>
          </span>
          {!dz.sameWallClock && (
            <span className="block text-sm text-muted-foreground">
              {t("web.dashboard.students.header.theirTime", {
                time: dz.other.timeLabel,
                city: timezoneCityLabel(dz.other.tz),
              })}
            </span>
          )}
        </span>
        {showStatus ? (
          <Badge variant={status.variant} className="shrink-0">
            {status.label}
          </Badge>
        ) : (
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </Link>
    </li>
  );
}

function ClassListCard({
  title,
  items,
  emptyLabel,
  action,
  ...rowProps
}: {
  title: string;
  items: ClassRowItem[];
  emptyLabel: string;
  action?: React.ReactNode;
  studentName: string;
  teacherTimezone: string;
  studentTimezone: string;
  locale: AppLocale;
  t: TFunction;
  showStatus: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-4">
        <CardTitle className="text-lg" as="h2">
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="divide-y border-t">
            {items.map((item) => (
              <ClassRow key={item.id} item={item} {...rowProps} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** A labelled line of the briefing, or the honest absence of one. */
function BriefingRow({
  label,
  value,
  empty,
}: {
  label: string;
  value: string | null;
  empty: string;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm", !value && "text-muted-foreground")}>{value || empty}</dd>
    </div>
  );
}

export async function OverviewTab({
  studentId,
  studentName,
  teacher,
  locale,
  t,
  now,
  limit,
  studentTimezone,
  goals,
  interests,
  levelLabel,
  liveBookingId,
}: {
  studentId: string;
  studentName: string;
  teacher: Teacher;
  locale: AppLocale;
  t: TFunction;
  now: Date;
  limit: number;
  studentTimezone: string;
  goals: string | null;
  interests: string | null;
  levelLabel: string | null;
  liveBookingId: string | null;
}) {
  const [upcoming, past, notes, learningProfile] = await Promise.all([
    prisma.booking.findMany({
      where: {
        teacherId: teacher.id,
        studentId,
        status: "scheduled",
        scheduledEnd: { gte: now },
      },
      orderBy: { scheduledStart: "asc" },
      take: limit,
      select: { id: true, scheduledStart: true, status: true },
    }),
    // Everything already behind us, whatever it ended as — a cancellation is
    // part of the history a teacher is trying to recall.
    prisma.booking.findMany({
      where: { teacherId: teacher.id, studentId, scheduledEnd: { lt: now } },
      orderBy: { scheduledStart: "desc" },
      take: limit,
      select: { id: true, scheduledStart: true, status: true },
    }),
    prisma.studentNote.findMany({
      where: { teacherId: teacher.id, studentId },
      orderBy: { createdAt: "desc" },
      select: { id: true, body: true, createdAt: true, updatedAt: true },
    }),
    prisma.studentLearningProfile.findUnique({
      where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
      select: { profile: true },
    }),
  ]);

  const noteViews: StudentNoteView[] = notes.map((n) => ({
    id: n.id,
    body: n.body,
    timestampLabel: formatZonedDateTime(n.createdAt, teacher.timezone, locale),
    // @updatedAt equals created_at at creation; treat a >1s gap as a real edit.
    edited: n.updatedAt.getTime() - n.createdAt.getTime() > 1000,
  }));

  // The focus areas, read-only and topped at three. The full profile — trends,
  // recurrence counts, vocabulary queue, consent — is the Learning tab's job;
  // what belongs here is the answer to "what am I working on with her".
  const parsedProfile = learningProfile?.profile
    ? profileSchema.safeParse(learningProfile.profile)
    : null;
  const focusSkills = parsedProfile?.success
    ? Object.values(parsedProfile.data.byCategory)
        .flatMap((skills) => Object.entries(skills))
        .sort(([, a], [, b]) => b.recurrenceCount - a.recurrenceCount)
        .slice(0, 3)
        .map(([skill]) => skillLabel(t, skill))
    : [];

  const rowProps = {
    studentName,
    teacherTimezone: teacher.timezone,
    studentTimezone,
    locale,
    t,
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
      <div className="space-y-6 lg:col-span-2">
        {/* Every row in the list below is already a link to its class, and a
            button inside a link is not something HTML can express — so the
            join action has to be its own object. It exists only for the fifty
            minutes it is true. */}
        {liveBookingId && (
          <CallCta
            href={`/dashboard/classes/${liveBookingId}/call`}
            title={studentName}
            subtitle={t("web.dashboard.classes.list.liveNow")}
            cta={t("call.join")}
          />
        )}

        <ClassListCard
          title={t("web.dashboard.students.overview.upcoming")}
          items={upcoming}
          emptyLabel={t("web.dashboard.students.overview.noUpcoming")}
          showStatus={false}
          action={
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <Link href={`/dashboard/classes/book?studentId=${studentId}`}>
                <CalendarClock className="size-4" aria-hidden />
                {t("web.dashboard.students.bookClass")}
              </Link>
            </Button>
          }
          {...rowProps}
        />

        <ClassListCard
          title={t("web.dashboard.students.recentClasses")}
          items={past}
          emptyLabel={t("web.dashboard.students.noClasses")}
          showStatus
          action={
            past.length > 0 ? (
              <Button asChild size="sm" variant="ghost" className="shrink-0">
                <Link href="/dashboard/classes?show=past">
                  {t("web.dashboard.students.overview.allClasses")}
                </Link>
              </Button>
            ) : undefined
          }
          {...rowProps}
        />
      </div>

      <aside className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-4">
            <CardTitle className="text-lg" as="h2">
              {t("web.dashboard.students.overview.briefing")}
            </CardTitle>
            <Button asChild size="sm" variant="ghost" className="shrink-0">
              <Link href={studentDetailHref(studentId, "learning")}>{t("common.edit")}</Link>
            </Button>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3">
              <BriefingRow
                label={t("web.studentLevel.label")}
                value={levelLabel}
                empty={t("web.studentLevel.notSet")}
              />
              <BriefingRow
                label={t("web.studentProfileForm.goalLabel")}
                value={goals}
                empty={t("web.dashboard.students.overview.notSetYet")}
              />
              <BriefingRow
                label={t("web.studentProfileForm.interestsLabel")}
                value={interests}
                empty={t("web.dashboard.students.overview.notSetYet")}
              />
              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground">
                  {t("web.dashboard.students.overview.focusAreas")}
                </dt>
                <dd>
                  {focusSkills.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("web.dashboard.students.overview.noFocusYet")}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {focusSkills.map((skill) => (
                        <Badge key={skill} variant="outline">
                          {skill}
                        </Badge>
                      ))}
                    </div>
                  )}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Notes live on this tab and only on this tab. They are what a teacher
            writes in the minute before a class and reads in the minute before
            the next one — which is exactly the moment this view is for. */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg" as="h2">
              {t("web.dashboard.students.notes.title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StudentNotes studentId={studentId} notes={noteViews} />
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
