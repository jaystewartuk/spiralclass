import "server-only";
import {
  buildWeeklyPlan,
  isMarketingPlatform,
  isPromoPolicy,
  weekStartOf,
  type PlannerCommunity,
  type PlannerSignals,
  type ReferralCandidate,
  type WeeklyPlan,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { createActivity, listActivities, type ActivityView } from "./activities";
import { buildTeacherContext, type TeacherContext } from "./profile";

// Turning the pure weekly plan into rows.
//
// The split matters: `buildWeeklyPlan` in @spiralclass/shared decides WHAT the
// week should contain from signals alone (pure, unit-tested, no database), and
// this module gathers those signals and persists the result. A plan is
// therefore reproducible from its inputs, and "why did it schedule that" is
// answerable without a debugger.

/** How far back a community's results are read for ranking. */
const RESULTS_WINDOW_DAYS = 120;

async function communitySignals(teacherId: string): Promise<PlannerCommunity[]> {
  const [communities, events, lastActivity] = await Promise.all([
    prisma.teacherShareGroup.findMany({
      where: { teacherId, archivedAt: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, platform: true, promoPolicy: true },
    }),
    prisma.acquisitionEvent.groupBy({
      by: ["communityId", "kind"],
      where: {
        teacherId,
        communityId: { not: null },
        occurredAt: { gte: new Date(Date.now() - RESULTS_WINDOW_DAYS * 86400_000) },
      },
      _count: { _all: true },
    }),
    prisma.marketingActivity.groupBy({
      by: ["communityId"],
      where: { teacherId, communityId: { not: null }, status: "done" },
      _max: { completedAt: true },
    }),
  ]);

  const counts = new Map<string, { visits: number; enquiries: number; students: number }>();
  for (const e of events) {
    if (!e.communityId) continue;
    const entry = counts.get(e.communityId) ?? { visits: 0, enquiries: 0, students: 0 };
    if (e.kind === "visit") entry.visits = e._count._all;
    else if (e.kind === "enquiry") entry.enquiries = e._count._all;
    else if (e.kind === "purchase") entry.students = e._count._all;
    counts.set(e.communityId, entry);
  }

  const lastByCommunity = new Map<string, Date | null>();
  for (const a of lastActivity) {
    if (a.communityId) lastByCommunity.set(a.communityId, a._max.completedAt);
  }

  return communities.map((c) => {
    const r = counts.get(c.id) ?? { visits: 0, enquiries: 0, students: 0 };
    return {
      id: c.id,
      name: c.name,
      platform: isMarketingPlatform(c.platform) ? c.platform : "other",
      promoPolicy: isPromoPolicy(c.promoPolicy) ? c.promoPolicy : "unknown",
      lastActivityAt: lastByCommunity.get(c.id) ?? null,
      ...r,
    };
  });
}

/**
 * Students it would be natural to ask for a referral right now.
 *
 * Ordered by how strong the moment is, and capped hard: a plan that tells a
 * teacher to message six students is a plan that gets ignored, and a teacher
 * who messages six students in one week is doing something that reads as spam
 * to the people receiving it. One per week is the whole design.
 */
export async function referralCandidatesFor(
  teacherId: string,
  limit = 2,
): Promise<ReferralCandidate[]> {
  const since = new Date(Date.now() - 21 * 86400_000);

  // Someone whose first lesson just happened: the highest-intent moment there
  // is, and the one a teacher most reliably forgets.
  const recentFirsts = await prisma.booking.findMany({
    where: { teacherId, status: "completed", scheduledStart: { gte: since } },
    orderBy: { scheduledStart: "desc" },
    take: 25,
    select: { studentId: true, student: { select: { name: true } } },
  });

  const seen = new Set<string>();
  const out: ReferralCandidate[] = [];
  for (const b of recentFirsts) {
    if (seen.has(b.studentId)) continue;
    seen.add(b.studentId);
    const priorCount = await prisma.booking.count({
      where: { teacherId, studentId: b.studentId, status: "completed" },
    });
    // Skip anyone already asked recently — an ask is a one-off, not a drip.
    const alreadyAsked = await prisma.marketingActivity.findFirst({
      where: {
        teacherId,
        studentId: b.studentId,
        kind: "referral_ask",
        createdAt: { gte: new Date(Date.now() - 90 * 86400_000) },
      },
      select: { id: true },
    });
    if (alreadyAsked) continue;
    out.push({
      studentId: b.studentId,
      studentName: b.student.name,
      trigger: priorCount <= 1 ? "first_lesson" : "renewal",
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function gatherPlannerSignals(
  teacherId: string,
  context: TeacherContext,
  now: Date,
): Promise<PlannerSignals> {
  const [communities, referralCandidates, recent] = await Promise.all([
    communitySignals(teacherId),
    referralCandidatesFor(teacherId),
    prisma.marketingActivity.findMany({
      where: { teacherId, createdAt: { gte: new Date(now.getTime() - 60 * 86400_000) } },
      select: { kind: true, communityId: true, createdAt: true },
      take: 200,
    }),
  ]);

  return {
    communities,
    capabilities: context.capabilities,
    referralCandidates,
    recentActivities: recent.map((r) => ({
      kind: r.kind as PlannerSignals["recentActivities"][number]["kind"],
      communityId: r.communityId,
      at: r.createdAt,
    })),
    weeklyMinutes: context.profile.weeklyMinutes,
    now,
  };
}

export type PlanView = {
  id: string | null;
  weekStart: Date;
  weeklyMinutes: number;
  activities: ActivityView[];
};

/**
 * Ensure this week's plan exists, creating the missing activities.
 *
 * Idempotent and additive: activities the teacher already acted on are never
 * touched, and an existing plan is only topped up to the budget. That is what
 * makes it safe to call on every page load AND from the weekly cron.
 */
export async function ensureWeeklyPlan(input: {
  teacherId: string;
  now?: Date;
  context?: TeacherContext;
}): Promise<PlanView | null> {
  const now = input.now ?? new Date();
  const context = input.context ?? (await buildTeacherContext(input.teacherId));
  if (!context) return null;

  const weekStart = weekStartOf(now);
  const plan = await prisma.marketingPlan.upsert({
    where: { teacherId_weekStart: { teacherId: input.teacherId, weekStart } },
    create: {
      teacherId: input.teacherId,
      weekStart,
      weeklyMinutes: context.profile.weeklyMinutes,
    },
    update: {},
    select: { id: true, weekStart: true, weeklyMinutes: true },
  });

  const existing = await prisma.marketingActivity.count({ where: { planId: plan.id } });
  if (existing === 0) {
    const signals = await gatherPlannerSignals(input.teacherId, context, now);
    const built: WeeklyPlan = buildWeeklyPlan(signals);
    for (const action of built.actions) {
      await createActivity({
        teacherId: input.teacherId,
        planId: plan.id,
        communityId: action.communityId,
        studentId: action.studentId,
        kind: action.kind,
        platform: action.platform,
        reason: action.reason,
      });
    }
  }

  const activities = await listActivities(input.teacherId, { planId: plan.id });
  return {
    id: plan.id,
    weekStart: plan.weekStart,
    weeklyMinutes: plan.weeklyMinutes,
    activities,
  };
}

/**
 * Rebuild the current week from scratch, discarding only what she has not
 * acted on. Her history is never rewritten by a regenerate.
 */
export async function regenerateWeeklyPlan(input: {
  teacherId: string;
  now?: Date;
}): Promise<PlanView | null> {
  const now = input.now ?? new Date();
  const weekStart = weekStartOf(now);
  const plan = await prisma.marketingPlan.findUnique({
    where: { teacherId_weekStart: { teacherId: input.teacherId, weekStart } },
    select: { id: true },
  });
  if (plan) {
    await prisma.marketingActivity.deleteMany({
      where: { planId: plan.id, status: { in: ["planned", "skipped"] } },
    });
  }
  return ensureWeeklyPlan({ teacherId: input.teacherId, now });
}
