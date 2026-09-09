import type { PrismaClient } from "@prisma/client";

import { logger } from "@/lib/logger";
import { DEFAULT_LESSON_LANGUAGE } from "@/lib/transcription/config";
import { profileSchema } from "./profile";
import {
  generateBrief as defaultGenerate,
  profileHasSignal,
  BriefUnavailableError,
  type Brief,
} from "./brief";

// Phase F brief orchestration. On
// demand — when the teacher opens an upcoming class — get the cached brief or
// (re)generate it from the student's profile. Cached one-per-booking; regenerated
// only when the profile changed since (so a page view doesn't re-call Claude).
// Degrades gracefully: no profile / no signal / no ANTHROPIC key → null (no brief,
// no error). Side effects injected for testability.

const log = logger({ surface: "lesson-brief" });

type Db = Pick<PrismaClient, "booking" | "studentLearningProfile" | "lessonBrief">;

export type BriefDeps = {
  prisma: Db;
  generate: typeof defaultGenerate;
};

export type BriefResult = { brief: Brief; generatedAt: Date } | null;

export async function getOrGenerateBrief(deps: BriefDeps, bookingId: string): Promise<BriefResult> {
  const { prisma } = deps;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      teacherId: true,
      studentId: true,
      student: { select: { name: true } },
      teacher: { select: { locale: true } },
    },
  });
  if (!booking) return null;

  const profileRow = await prisma.studentLearningProfile.findUnique({
    where: { teacherId_studentId: { teacherId: booking.teacherId, studentId: booking.studentId } },
    select: { profile: true, updatedAt: true },
  });
  if (!profileRow) return null;

  const parsedProfile = profileSchema.safeParse(profileRow.profile);
  if (!parsedProfile.success || !profileHasSignal(parsedProfile.data)) return null;

  // Cache hit: a brief generated at or after the profile's last change is fresh.
  const existing = await prisma.lessonBrief.findUnique({
    where: { bookingId },
    select: { content: true, generatedAt: true },
  });
  if (existing && existing.generatedAt >= profileRow.updatedAt) {
    return { brief: existing.content as unknown as Brief, generatedAt: existing.generatedAt };
  }

  // Generate (or regenerate a stale brief).
  let generated: { brief: Brief; model: string };
  try {
    generated = await deps.generate({
      studentName: booking.student.name,
      language: DEFAULT_LESSON_LANGUAGE,
      profile: parsedProfile.data,
      en: booking.teacher.locale === "en",
    });
  } catch (err) {
    if (err instanceof BriefUnavailableError) return null; // degrade-gracefully
    throw err;
  }

  const row = await prisma.lessonBrief.upsert({
    where: { bookingId },
    create: {
      bookingId,
      teacherId: booking.teacherId,
      content: generated.brief as unknown as object,
      model: generated.model,
    },
    update: {
      content: generated.brief as unknown as object,
      model: generated.model,
      generatedAt: new Date(),
    },
    select: { generatedAt: true },
  });

  log.info("brief generated", { bookingId, focus: generated.brief.focus.length });
  return { brief: generated.brief, generatedAt: row.generatedAt };
}
