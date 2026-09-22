import "server-only";
import type { PageSignals } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { introVideoStorageConfigured } from "@/lib/storage/teacher-video";

// Reads the facts `pageReadiness` judges the public booking page on.
//
// The two counts MUST use the same filters the public page renders with —
// `archived: false` for packages, `published: true` for testimonials (see
// app/b/[slug]/page.tsx). Counting the raw rows instead would tell a teacher
// her page has testimonials on it while every one of them is unpublished, and
// a check that disagrees with the page it is checking is worse than no check.

export type PageSignalTeacher = {
  id: string;
  photoPath: string | null;
  headline: string | null;
  bio: string | null;
  introVideoPath: string | null;
};

export async function pageSignalsFor(teacher: PageSignalTeacher): Promise<PageSignals> {
  const [packageCount, testimonialCount] = await Promise.all([
    prisma.packageTemplate.count({ where: { teacherId: teacher.id, archived: false } }),
    prisma.testimonial.count({ where: { teacherId: teacher.id, published: true } }),
  ]);
  return {
    hasPhoto: Boolean(teacher.photoPath),
    headline: teacher.headline,
    bio: teacher.bio,
    packageCount,
    testimonialCount,
    hasIntroVideo: Boolean(teacher.introVideoPath),
    // Never ask for a video the deploy has nowhere to put.
    introVideoOfferable: introVideoStorageConfigured(),
  };
}
