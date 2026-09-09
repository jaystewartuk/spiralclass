import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { InsightCategory } from "@prisma/client";

import { normaliseSkill } from "./skills";
import { computeSpeakingTime, type SpeakingTimeSummary } from "./speaking-time";
import type { SpeakerUtterance } from "@/lib/transcription/types";

// The longitudinal learning profile (lesson-insights Phase E,
// the Phase E design). A materialised rollup of a
// student's CONFIRMED insights, grouped by category + skill, with a recurrence
// count and a trend, plus a vocabulary queue. computeProfile is pure (the
// substance, heavily unit-tested); recomputeStudentProfile wires it to the DB and
// is called after every validation mutation.

// A skill absent from the student's most recent N lessons reads as "improving".
export const RECENT_LESSONS_WINDOW = 2;

export const TRENDS = ["focus", "improving", "new"] as const;
export type Trend = (typeof TRENDS)[number];

// A confirmed (or teacher-authored) insight, with its lesson date — the input.
export type ProfileInsight = {
  category: InsightCategory;
  skill: string | null;
  summary: string;
  evidence: string | null;
  lessonAt: Date;
};

const skillEntrySchema = z.object({
  recurrenceCount: z.number().int().nonnegative(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  trend: z.enum(TRENDS),
  lastEvidence: z.string().nullable(),
});
const vocabEntrySchema = z.object({ term: z.string(), lastSeenAt: z.string() });

// Speaking-time rollup (D-97) — averaged across every lesson that had both a
// recording and a transcript. Optional/nullable/defaulted so profiles
// persisted before this field existed still parse.
const speakingBalanceSchema = z.object({
  teacherSharePct: z.number().min(0).max(100),
  studentSharePct: z.number().min(0).max(100),
  lessonsCounted: z.number().int().nonnegative(),
});
export type SpeakingBalance = z.infer<typeof speakingBalanceSchema>;

export const profileSchema = z.object({
  // byCategory[category][skill] → entry
  byCategory: z.record(z.string(), z.record(z.string(), skillEntrySchema)),
  vocabulary: z.array(vocabEntrySchema),
  speakingBalance: speakingBalanceSchema.nullable().optional().default(null),
});
export type StudentProfile = z.infer<typeof profileSchema>;
export type SkillEntry = z.infer<typeof skillEntrySchema>;

// Pure: average the per-lesson speaking-time summaries into one rollup. Null
// when no lesson in the window has a usable summary (no recording yet, etc.).
export function aggregateSpeakingBalance(perLesson: SpeakingTimeSummary[]): SpeakingBalance | null {
  if (perLesson.length === 0) return null;
  const teacherAvg = perLesson.reduce((sum, s) => sum + s.teacherSharePct, 0) / perLesson.length;
  const studentAvg = perLesson.reduce((sum, s) => sum + s.studentSharePct, 0) / perLesson.length;
  return {
    teacherSharePct: Math.round(teacherAvg),
    studentSharePct: Math.round(studentAvg),
    lessonsCounted: perLesson.length,
  };
}

function groupKey(i: ProfileInsight): string {
  return i.skill && i.skill.trim() ? i.skill : normaliseSkill(i.summary);
}

// Pure: roll a student's confirmed insights into the profile. `lessonsByDate` is
// the student's lessons ordered ascending; its tail defines "recent" for trend.
// `speakingBalance` (D-97) is computed independently of confirmed insights —
// it just passes through.
export function computeProfile(
  insights: ProfileInsight[],
  lessonsByDate: Date[],
  speakingBalance: SpeakingBalance | null = null,
): StudentProfile {
  const recent = new Set(lessonsByDate.slice(-RECENT_LESSONS_WINDOW).map((d) => d.getTime()));

  const byCategory: Record<string, Record<string, SkillEntry>> = {};
  // Group insights by category + skill, keeping the structured key (no fragile
  // string-splitting).
  const groups = new Map<
    string,
    { category: InsightCategory; skill: string; items: ProfileInsight[] }
  >();
  for (const insight of insights) {
    const skill = groupKey(insight);
    const key = `${insight.category}::${skill}`;
    let group = groups.get(key);
    if (!group) {
      group = { category: insight.category, skill, items: [] };
      groups.set(key, group);
    }
    group.items.push(insight);
  }

  for (const { category, skill, items } of groups.values()) {
    const sorted = [...items].sort((a, b) => a.lessonAt.getTime() - b.lessonAt.getTime());
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const appearedRecently = sorted.some((i) => recent.has(i.lessonAt.getTime()));
    const recurrenceCount = sorted.length;

    const trend: Trend = !appearedRecently ? "improving" : recurrenceCount >= 2 ? "focus" : "new";

    (byCategory[category] ??= {})[skill] = {
      recurrenceCount,
      firstSeenAt: first.lessonAt.toISOString(),
      lastSeenAt: last.lessonAt.toISOString(),
      trend,
      lastEvidence: last.evidence,
    };
  }

  // Vocabulary queue: terms from vocabulary-category insights, dedup by
  // normalised term, keeping the latest sighting, newest first.
  const vocabByTerm = new Map<string, { term: string; lastSeenAt: Date }>();
  for (const insight of insights) {
    if (insight.category !== "vocabulary") continue;
    const term = insight.summary.trim();
    if (!term) continue;
    const norm = normaliseSkill(term);
    const existing = vocabByTerm.get(norm);
    if (!existing || insight.lessonAt > existing.lastSeenAt) {
      vocabByTerm.set(norm, { term, lastSeenAt: insight.lessonAt });
    }
  }
  const vocabulary = [...vocabByTerm.values()]
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .map((v) => ({ term: v.term, lastSeenAt: v.lastSeenAt.toISOString() }));

  return profileSchema.parse({ byCategory, vocabulary, speakingBalance });
}

type Db = Pick<
  PrismaClient,
  "lessonInsight" | "booking" | "studentLearningProfile" | "lessonAudio" | "lessonTranscript"
>;

// Recompute and upsert a student's profile from all their CONFIRMED insights,
// plus (D-97) a speaking-balance rollup averaged across every lesson that has
// both a completed recording and a transcript — independent of insights, so a
// lesson contributes to it even before/without a teacher validation pass.
// Called after every validation mutation. The set is bounded by lesson count, so
// inline recompute is fine. When the student has neither confirmed insights nor
// any speaking data, any stale profile row is removed.
export async function recomputeStudentProfile(
  prisma: Db,
  args: { teacherId: string; studentId: string },
): Promise<void> {
  const { teacherId, studentId } = args;

  const [insightRows, lessons, audioRows] = await Promise.all([
    prisma.lessonInsight.findMany({
      where: {
        teacherId,
        dismissedAt: null,
        confirmedAt: { not: null },
        booking: { studentId },
      },
      select: {
        category: true,
        skill: true,
        summary: true,
        evidence: true,
        booking: { select: { scheduledStart: true } },
      },
    }),
    prisma.booking.findMany({
      where: { teacherId, studentId },
      select: { scheduledStart: true },
      orderBy: { scheduledStart: "asc" },
    }),
    prisma.booking.findMany({
      where: { teacherId, studentId, lessonTranscript: { isNot: null } },
      select: {
        lessonAudio: { select: { durationMs: true } },
        lessonTranscript: { select: { utterances: true } },
      },
    }),
  ]);

  const perLessonSpeaking = audioRows
    .map((b) =>
      computeSpeakingTime(
        b.lessonAudio,
        (b.lessonTranscript?.utterances as unknown as SpeakerUtterance[] | undefined) ?? [],
      ),
    )
    .filter((s): s is SpeakingTimeSummary => s !== null);
  const speakingBalance = aggregateSpeakingBalance(perLessonSpeaking);

  if (insightRows.length === 0 && speakingBalance === null) {
    await prisma.studentLearningProfile.deleteMany({ where: { teacherId, studentId } });
    return;
  }

  const profile = computeProfile(
    insightRows.map((i) => ({
      category: i.category,
      skill: i.skill,
      summary: i.summary,
      evidence: i.evidence,
      lessonAt: i.booking.scheduledStart,
    })),
    lessons.map((l) => l.scheduledStart),
    speakingBalance,
  );

  await prisma.studentLearningProfile.upsert({
    where: { teacherId_studentId: { teacherId, studentId } },
    create: { teacherId, studentId, profile: profile as unknown as object },
    update: { profile: profile as unknown as object },
  });
}
