import type { PrismaClient, InsightCategory } from "@prisma/client";
import { z } from "zod";

import { recomputeStudentProfile } from "./profile";
import { suggestSkill } from "./skills";
import { logger } from "@/lib/logger";

const log = logger({ surface: "lesson-insights" });

// Core for the Phase-E validation loop (confirm / edit / dismiss / add), called
// by the web server action (app/actions/lesson-insights.ts). The ownership
// check (tenant isolation) and the inline profile recompute live here once so
// they can't drift. Each function returns a
// reason code; callers own auth + Pro-gating + any locale messaging/revalidation.

export type InsightOpResult =
  | { ok: true; bookingId: string; studentId: string }
  | { ok: false; reason: "not-found" | "invalid" | "save-failed" };

const CATEGORIES = ["pronunciation", "grammar", "vocabulary", "fluency", "comprehension"] as const;
const categorySchema = z.enum(CATEGORIES);
const MAX = 500;
const text = z.string().trim().min(1).max(MAX);

export const editInsightSchema = z.object({
  summary: text.optional(),
  suggestion: text.nullish(),
  category: categorySchema.optional(),
  skill: z.string().trim().max(80).optional(),
});
export type EditInsightInput = z.input<typeof editInsightSchema>;

export const addInsightSchema = z.object({
  category: categorySchema,
  summary: text,
  suggestion: text.nullish(),
  evidence: text.nullish(),
  skill: z.string().trim().max(80).optional(),
});
export type AddInsightInput = z.input<typeof addInsightSchema>;

// Load an insight the teacher owns, with the ids the recompute needs. Null when
// missing or not owned (tenant isolation).
async function ownedInsight(
  prisma: PrismaClient,
  insightId: string,
  teacherId: string,
): Promise<{
  id: string;
  bookingId: string;
  studentId: string;
  category: InsightCategory;
  summary: string;
} | null> {
  if (!insightId) return null;
  const row = await prisma.lessonInsight.findFirst({
    where: { id: insightId, teacherId },
    select: {
      id: true,
      bookingId: true,
      category: true,
      summary: true,
      booking: { select: { studentId: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.bookingId,
    studentId: row.booking.studentId,
    category: row.category,
    summary: row.summary,
  };
}

async function recompute(
  prisma: PrismaClient,
  teacherId: string,
  studentId: string,
): Promise<void> {
  await recomputeStudentProfile(prisma, { teacherId, studentId });
}

// Confirm an AI finding as-is, attaching the grouping skill (UI pre-fills a
// suggestion; the teacher can override it in the same pass).
export async function confirmInsightFor(
  prisma: PrismaClient,
  teacherId: string,
  insightId: string,
  skill?: string,
): Promise<InsightOpResult> {
  const owned = await ownedInsight(prisma, insightId, teacherId);
  if (!owned) return { ok: false, reason: "not-found" };
  try {
    await prisma.lessonInsight.update({
      where: { id: owned.id },
      data: {
        confirmedAt: new Date(),
        dismissedAt: null,
        skill: skill?.trim() || suggestSkill(owned.category, owned.summary),
      },
    });
    await recompute(prisma, teacherId, owned.studentId);
  } catch (err) {
    log.error("confirm insight failed", err, { insightId });
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true, bookingId: owned.bookingId, studentId: owned.studentId };
}

// Edit a finding and confirm it in one step (an edit is an implicit confirm).
export async function editInsightFor(
  prisma: PrismaClient,
  teacherId: string,
  insightId: string,
  input: EditInsightInput,
): Promise<InsightOpResult> {
  const owned = await ownedInsight(prisma, insightId, teacherId);
  if (!owned) return { ok: false, reason: "not-found" };

  const parsed = editInsightSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { summary, suggestion, category, skill } = parsed.data;
  const finalCategory = category ?? owned.category;
  const finalSummary = summary ?? owned.summary;

  try {
    await prisma.lessonInsight.update({
      where: { id: owned.id },
      data: {
        ...(summary !== undefined ? { summary } : {}),
        ...(suggestion !== undefined ? { suggestion: suggestion ?? null } : {}),
        ...(category !== undefined ? { category } : {}),
        skill: skill?.trim() || suggestSkill(finalCategory, finalSummary),
        confirmedAt: new Date(),
        dismissedAt: null,
      },
    });
    await recompute(prisma, teacherId, owned.studentId);
  } catch (err) {
    log.error("edit insight failed", err, { insightId });
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true, bookingId: owned.bookingId, studentId: owned.studentId };
}

// Dismiss a finding — a negative label that never feeds the profile (clears any
// prior confirmation).
export async function dismissInsightFor(
  prisma: PrismaClient,
  teacherId: string,
  insightId: string,
): Promise<InsightOpResult> {
  const owned = await ownedInsight(prisma, insightId, teacherId);
  if (!owned) return { ok: false, reason: "not-found" };
  try {
    await prisma.lessonInsight.update({
      where: { id: owned.id },
      data: { dismissedAt: new Date(), confirmedAt: null },
    });
    await recompute(prisma, teacherId, owned.studentId);
  } catch (err) {
    log.error("dismiss insight failed", err, { insightId });
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true, bookingId: owned.bookingId, studentId: owned.studentId };
}

// Add a teacher-authored focus area (source="teacher", confirmed on creation).
export async function addInsightFor(
  prisma: PrismaClient,
  teacherId: string,
  bookingId: string,
  input: AddInsightInput,
): Promise<InsightOpResult> {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId },
    select: { id: true, studentId: true },
  });
  if (!booking) return { ok: false, reason: "not-found" };

  const parsed = addInsightSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { category, summary, suggestion, evidence, skill } = parsed.data;

  try {
    await prisma.lessonInsight.create({
      data: {
        bookingId: booking.id,
        teacherId,
        category,
        summary,
        suggestion: suggestion ?? null,
        evidence: evidence ?? null,
        skill: skill?.trim() || suggestSkill(category, summary),
        source: "teacher",
        confirmedAt: new Date(),
      },
    });
    await recompute(prisma, teacherId, booking.studentId);
  } catch (err) {
    log.error("add insight failed", err, { bookingId });
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true, bookingId: booking.id, studentId: booking.studentId };
}
