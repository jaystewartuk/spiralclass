import type { PrismaClient } from "@prisma/client";
import type { AppLocale, TFunction } from "@/lib/i18n-translate";
import { formatZonedDateTime } from "@/lib/date-display";
import { LEAD_SCOPE_STATUSES, LEAD_SCOPES, leadsHref } from "@/lib/leads/list";
import { prisma as defaultPrisma } from "@/lib/prisma";
import type { SearchEntry } from "./match";
import { materialsSearchHref } from "./within";

// The teacher's own records, as site-search entries: her students, her classes
// either side of today, her package templates, her leads and her library.
//
// TENANCY. Every query below is scoped by the teacher id the caller resolved
// from the session, and nothing else — there is no query parameter to widen
// it, because the route takes none. tests/search/teacher-records.integration
// .test.ts seeds two teachers and asserts neither index contains a row of the
// other's.
//
// SIZE. The whole index ships to the browser once per open, so each list is
// bounded. The bounds sit well above a working teacher's real numbers (a
// roster is tens of rows); the "search classes for …" style fallbacks in the
// dialog hand a query past the bound to the page that searches everything.

export const CLASS_WINDOW_PAST_DAYS = 30;
export const CLASS_WINDOW_FUTURE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export const RECORD_LIMITS = {
  students: 500,
  classes: 200,
  packages: 100,
  leads: 200,
  materials: 300,
} as const;

export type TeacherSearchContext = {
  teacher: { id: string; timezone: string };
  locale: AppLocale;
  t: TFunction;
  now: Date;
};

export async function teacherSearchRecords(
  ctx: TeacherSearchContext,
  db: PrismaClient = defaultPrisma,
): Promise<SearchEntry[]> {
  const { teacher, locale, t, now } = ctx;
  const teacherId = teacher.id;

  const [roster, bookings, templates, leads, materials] = await Promise.all([
    db.teacherStudent.findMany({
      where: { teacherId },
      select: { archivedAt: true, student: { select: { id: true, name: true, email: true } } },
      orderBy: { student: { name: "asc" } },
      take: RECORD_LIMITS.students,
    }),
    db.booking.findMany({
      where: {
        teacherId,
        status: { in: ["scheduled", "completed"] },
        scheduledStart: {
          gte: new Date(now.getTime() - CLASS_WINDOW_PAST_DAYS * DAY_MS),
          lte: new Date(now.getTime() + CLASS_WINDOW_FUTURE_DAYS * DAY_MS),
        },
      },
      select: {
        id: true,
        scheduledStart: true,
        student: { select: { name: true } },
        package: { select: { template: { select: { name: true } } } },
      },
      orderBy: { scheduledStart: "asc" },
      take: RECORD_LIMITS.classes,
    }),
    db.packageTemplate.findMany({
      where: { teacherId, archived: false },
      select: { id: true, name: true, subject: true },
      orderBy: { createdAt: "asc" },
      take: RECORD_LIMITS.packages,
    }),
    db.lead.findMany({
      where: { teacherId },
      select: { id: true, name: true, email: true, status: true },
      orderBy: { createdAt: "desc" },
      take: RECORD_LIMITS.leads,
    }),
    db.libraryMaterial.findMany({
      // Library items only: a material with a booking id is one class's own
      // content, reached from that class.
      where: { teacherId, bookingId: null, archived: false, label: { not: null } },
      select: { id: true, label: true, unit: true },
      orderBy: { createdAt: "desc" },
      take: RECORD_LIMITS.materials,
    }),
  ]);

  const entries: SearchEntry[] = [];

  for (const row of roster) {
    const { student } = row;
    const archived = row.archivedAt != null;
    entries.push({
      id: `student.${student.id}`,
      kind: "student",
      label: student.name,
      detail: student.email ?? undefined,
      href: `/dashboard/students/${student.id}`,
      archived: archived || undefined,
    });
    // The thing a teacher most often wants with a name is to write to them.
    if (!archived) {
      entries.push({
        id: `message.${student.id}`,
        kind: "action",
        label: t("web.search.messageTo", { name: student.name }),
        href: `/dashboard/messages/${student.id}`,
        terms: student.name,
      });
    }
  }

  // Upcoming first, soonest first; then the recent past, most recent first —
  // "Ana's class" almost always means the next one.
  const upcoming = bookings.filter((b) => b.scheduledStart >= now);
  const past = bookings.filter((b) => b.scheduledStart < now).reverse();
  for (const booking of [...upcoming, ...past]) {
    const when = formatZonedDateTime(booking.scheduledStart, teacher.timezone, locale);
    const template = booking.package.template?.name;
    entries.push({
      id: `class.${booking.id}`,
      kind: "class",
      label: t("web.search.classWith", { name: booking.student.name }),
      detail: template ? `${when} · ${template}` : when,
      href: `/dashboard/classes/${booking.id}`,
      terms: booking.student.name,
    });
  }

  for (const template of templates) {
    entries.push({
      id: `package.${template.id}`,
      kind: "package",
      label: template.name,
      detail: template.subject ?? undefined,
      href: "/settings/templates",
    });
  }

  for (const lead of leads) {
    const scope = LEAD_SCOPES.find((s) => LEAD_SCOPE_STATUSES[s].includes(lead.status)) ?? "open";
    entries.push({
      id: `lead.${lead.id}`,
      kind: "lead",
      label: lead.name,
      detail: lead.email,
      href: leadsHref(scope, lead.name),
      archived: lead.status === "archived" || undefined,
    });
  }

  for (const material of materials) {
    if (!material.label) continue;
    entries.push({
      id: `material.${material.id}`,
      kind: "material",
      label: material.label,
      detail: material.unit ?? undefined,
      href: materialsSearchHref(material.label),
    });
  }

  return entries;
}
