import type { PrismaClient } from "@prisma/client";
import { FALLBACK_TIMEZONE } from "@spiralclass/shared";
import type { AppLocale, TFunction } from "@/lib/i18n-translate";
import { formatZonedDateTime } from "@/lib/date-display";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { CLASS_WINDOW_FUTURE_DAYS, CLASS_WINDOW_PAST_DAYS, RECORD_LIMITS } from "./teacher-records";
import type { SearchEntry } from "./match";

// The student's own records, as site-search entries: her teachers and her
// classes either side of today.
//
// Scoped by the student ids of the signed-in identity — the linked row plus
// its same-email siblings under other teachers, exactly the set the portal
// home and "My teachers" read (lib/students/identity.ts). A student row is
// per-teacher, so a student id is already a tenant scope.
//
// Materials are deliberately NOT indexed. What a student may see of a library
// depends on her level, the item's visibility and its send time; restating
// that rule here would be a second copy of it that could disagree with the
// materials page. The dialog hands a query to that page instead
// (/my-classes/materials?q=…), which applies the rule it owns.

const DAY_MS = 24 * 60 * 60 * 1000;

export type StudentSearchContext = {
  student: { id: string; email: string | null; timezone: string | null };
  locale: AppLocale;
  t: TFunction;
  now: Date;
};

export async function studentSearchRecords(
  ctx: StudentSearchContext,
  db: PrismaClient = defaultPrisma,
): Promise<SearchEntry[]> {
  const { student, locale, t, now } = ctx;
  const studentIds = await studentIdentityIds(student, db);
  const timezone = student.timezone ?? FALLBACK_TIMEZONE;

  const [pairings, bookings] = await Promise.all([
    db.teacherStudent.findMany({
      where: { studentId: { in: studentIds }, archivedAt: null },
      select: { teacher: { select: { id: true, name: true } } },
    }),
    db.booking.findMany({
      where: {
        studentId: { in: studentIds },
        status: { in: ["scheduled", "completed"] },
        scheduledStart: {
          gte: new Date(now.getTime() - CLASS_WINDOW_PAST_DAYS * DAY_MS),
          lte: new Date(now.getTime() + CLASS_WINDOW_FUTURE_DAYS * DAY_MS),
        },
      },
      select: {
        id: true,
        scheduledStart: true,
        teacher: { select: { name: true } },
        package: { select: { template: { select: { name: true } } } },
      },
      orderBy: { scheduledStart: "asc" },
      take: RECORD_LIMITS.classes,
    }),
  ]);

  const entries: SearchEntry[] = [];

  // One entry per teacher, even when two of her rows pair with the same one.
  const teachers = new Map(pairings.map((p) => [p.teacher.id, p.teacher.name]));
  for (const [id, name] of teachers) {
    entries.push({
      id: `teacher.${id}`,
      kind: "teacher",
      label: name,
      href: `/my-classes/teachers/${id}`,
    });
    entries.push({
      id: `message.${id}`,
      kind: "action",
      label: t("web.search.messageTo", { name }),
      href: `/my-classes/messages/${id}`,
      terms: name,
    });
  }

  const upcoming = bookings.filter((b) => b.scheduledStart >= now);
  const past = bookings.filter((b) => b.scheduledStart < now).reverse();
  for (const booking of [...upcoming, ...past]) {
    const when = formatZonedDateTime(booking.scheduledStart, timezone, locale);
    const template = booking.package.template?.name;
    entries.push({
      id: `class.${booking.id}`,
      kind: "class",
      label: t("web.search.classWith", { name: booking.teacher.name }),
      detail: template ? `${when} · ${template}` : when,
      href: `/my-classes/${booking.id}`,
      terms: booking.teacher.name,
    });
  }

  return entries;
}
