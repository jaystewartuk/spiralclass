"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import {
  confirmInsightFor,
  editInsightFor,
  dismissInsightFor,
  addInsightFor,
  type InsightOpResult,
  type EditInsightInput,
  type AddInsightInput,
} from "@/lib/lesson-notes/insight-actions";

// Phase E teacher validation loop (the Phase E design,
// D-19). Web server-action wrappers around the shared core
// (lib/lesson-notes/insight-actions.ts), which owns the ownership check and the
// inline profile recompute — shared verbatim with the mobile routes. Here we add
// web auth + Pro-gating + locale-aware messages + cache revalidation.

export type LessonInsightActionState = { error?: string; ok?: boolean };

async function gate(): Promise<
  { ok: true; teacherId: string; en: boolean } | { ok: false; error: string }
> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const pro = await gateProFeature(teacher.id, "lesson_notes");
  if (!pro.ok) return { ok: false, error: upgradeNudge(pro.limit, locale) };
  return { ok: true, teacherId: teacher.id, en };
}

// Map a core reason code to the web's locale-aware error string.
function message(reason: "not-found" | "invalid" | "save-failed", en: boolean): string {
  if (reason === "not-found")
    return en ? "Focus area not found." : "Área de enfoque no encontrada.";
  if (reason === "invalid")
    return en ? "Check the fields and try again." : "Revisa los campos e inténtalo de nuevo.";
  return en ? "Couldn't save. Please try again." : "No se pudo guardar. Inténtalo de nuevo.";
}

// On success the core hands back the affected ids so we revalidate the concrete
// teacher pages (the booking review card + the student profile).
function settle(res: InsightOpResult, en: boolean): LessonInsightActionState {
  if (!res.ok) return { error: message(res.reason, en) };
  revalidatePath(`/dashboard/classes/${res.bookingId}`);
  revalidatePath(`/dashboard/students/${res.studentId}`);
  return { ok: true };
}

export async function confirmInsight(
  insightId: string,
  skill?: string,
): Promise<LessonInsightActionState> {
  const g = await gate();
  if (!g.ok) return g;
  return settle(await confirmInsightFor(prisma, g.teacherId, insightId, skill), g.en);
}

export async function editInsight(
  insightId: string,
  input: EditInsightInput,
): Promise<LessonInsightActionState> {
  const g = await gate();
  if (!g.ok) return g;
  return settle(await editInsightFor(prisma, g.teacherId, insightId, input), g.en);
}

export async function dismissInsight(insightId: string): Promise<LessonInsightActionState> {
  const g = await gate();
  if (!g.ok) return g;
  return settle(await dismissInsightFor(prisma, g.teacherId, insightId), g.en);
}

export async function addInsight(
  bookingId: string,
  input: AddInsightInput,
): Promise<LessonInsightActionState> {
  const g = await gate();
  if (!g.ok) return g;
  return settle(await addInsightFor(prisma, g.teacherId, bookingId, input), g.en);
}
