import type { PrismaClient } from "@prisma/client";

import { normaliseSkill } from "./skills";

// Vocabulary flashcard study mode (D-97) — the flip side of a card. A
// VocabularyReview row only stores the bare term (SM-2 state), so the "back
// of the card" is recovered from the LessonInsight it was confirmed from:
// same teacher+student, category "vocabulary", matching term. No new data
// model — this reads data the insights pipeline already stores
// (evidence/suggestion), same as the profile's vocabulary queue does for the
// term itself (see profile.ts computeProfile).

export type VocabTerm = { id: string; term: string; teacherId: string; studentId: string };
export type VocabWithContext = { id: string; term: string; context: string | null };

type Db = Pick<PrismaClient, "lessonInsight">;

export async function attachVocabContext(
  prisma: Db,
  terms: VocabTerm[],
): Promise<VocabWithContext[]> {
  if (terms.length === 0) return [];

  const pairs = [...new Map(terms.map((t) => [`${t.teacherId}:${t.studentId}`, t])).values()];
  const insights = await prisma.lessonInsight.findMany({
    where: {
      category: "vocabulary",
      confirmedAt: { not: null },
      OR: pairs.map((p) => ({ teacherId: p.teacherId, booking: { studentId: p.studentId } })),
    },
    select: {
      teacherId: true,
      summary: true,
      evidence: true,
      suggestion: true,
      createdAt: true,
      booking: { select: { studentId: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Keep only the most recent sighting per (teacher, student, normalised term).
  const byKey = new Map<string, { evidence: string | null; suggestion: string | null }>();
  for (const insight of insights) {
    const key = `${insight.teacherId}:${insight.booking.studentId}:${normaliseSkill(insight.summary)}`;
    if (!byKey.has(key))
      byKey.set(key, { evidence: insight.evidence, suggestion: insight.suggestion });
  }

  return terms.map((t) => {
    const found = byKey.get(`${t.teacherId}:${t.studentId}:${normaliseSkill(t.term)}`);
    const context = found ? [found.evidence, found.suggestion].filter(Boolean).join(" — ") : "";
    return { id: t.id, term: t.term, context: context || null };
  });
}
