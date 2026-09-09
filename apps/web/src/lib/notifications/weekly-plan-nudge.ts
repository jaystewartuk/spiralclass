import type { PrismaClient } from "@prisma/client";
import {
  contentKindLabel,
  isMarketingContentKind,
  MINUTES_PER_ACTION,
  platformLabel,
  type AppLocale,
} from "@spiralclass/shared";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { enqueueStudentAcquisitionPlanTeacher } from "@/lib/notifications/enqueue";
import { ensureWeeklyPlan } from "@/lib/marketing/plan";

// The Monday student-acquisition nudge (D-125).
//
// This REPLACES the fortnightly Facebook-groups nudge, and the difference is
// the whole point of D-125: the old one told a teacher she should post
// somewhere. This one has already decided where, already written the post, and
// tells her what the first action is. A reminder to do unspecified marketing is
// the thing every teacher already ignores.
//
// Eligibility stays opt-in by use — only teachers with at least one saved
// community get a plan, so nobody is nudged toward an empty screen — and the
// "growth" preference category still suppresses it, exactly as before.

const DAY_MS = 24 * 60 * 60 * 1000;

export type WeeklyPlanNudgeDeps = {
  prisma: PrismaClient;
  emit?: (input: { notificationId: string; teacherId: string }) => Promise<void>;
  /** Minimum days between nudges to the same teacher. Default weekly. */
  cadenceDays?: number;
  now?: Date;
  /** Cap per run so one cron tick can't fan out unbounded work. */
  limit?: number;
};

export async function sendWeeklyPlanNudges(
  deps: WeeklyPlanNudgeDeps,
): Promise<{ ok: true; sent: number; skipped: number }> {
  const { prisma } = deps;
  const emit = deps.emit ?? emitNotificationQueued;
  const now = deps.now ?? new Date();
  // 6, not 7: a weekly cron running a few minutes earlier than last week must
  // still clear the window, or the nudge silently slips to fortnightly.
  const cadenceDays = deps.cadenceDays ?? 6;
  const cutoff = new Date(now.getTime() - cadenceDays * DAY_MS);
  const limit = deps.limit ?? 500;

  const grouped = await prisma.teacherShareGroup.groupBy({
    by: ["teacherId"],
    where: { archivedAt: null },
    _count: { _all: true },
  });
  if (grouped.length === 0) return { ok: true, sent: 0, skipped: 0 };

  const teacherIds = grouped.map((g) => g.teacherId).slice(0, limit);

  const recent = await prisma.notification.findMany({
    where: {
      templateName: "student_acquisition_plan_teacher",
      teacherId: { in: teacherIds },
      createdAt: { gte: cutoff },
    },
    select: { teacherId: true },
  });
  const nudgedRecently = new Set(recent.map((n) => n.teacherId));

  // Skip disabled teachers explicitly: a moderated account should not be
  // receiving growth mail.
  const active = await prisma.teacher.findMany({
    where: { id: { in: teacherIds }, disabledAt: null },
    select: { id: true, locale: true },
  });

  let sent = 0;
  let skipped = 0;

  for (const teacher of active) {
    if (nudgedRecently.has(teacher.id)) {
      skipped += 1;
      continue;
    }
    // Building the plan IS the work; the notification only announces it. Doing
    // it here rather than on her next page load means the content is already
    // waiting when she follows the link.
    const plan = await ensureWeeklyPlan({ teacherId: teacher.id, now });
    const pending = (plan?.activities ?? []).filter(
      (a) => a.status === "planned" || a.status === "ready",
    );
    if (pending.length === 0) {
      skipped += 1;
      continue;
    }

    const locale: AppLocale =
      teacher.locale === "en" ? "en" : teacher.locale === "fr" ? "fr" : "es-MX";
    const first = pending[0];
    const firstAction = [
      isMarketingContentKind(first.kind) ? contentKindLabel(first.kind, locale) : first.kind,
      first.community?.name ?? first.student?.name ?? platformLabel(first.platform, locale),
    ].join(" · ");

    const notificationId = await enqueueStudentAcquisitionPlanTeacher(prisma, {
      teacherId: teacher.id,
      actionCount: pending.length,
      firstAction,
      minutes: pending.length * MINUTES_PER_ACTION,
    });
    await emit({ notificationId, teacherId: teacher.id });
    sent += 1;
  }

  return { ok: true, sent, skipped };
}
