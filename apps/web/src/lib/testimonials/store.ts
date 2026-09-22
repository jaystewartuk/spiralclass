import { z } from "zod";
import type { TestimonialSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { TESTIMONIAL_AUTHOR_MAX, TESTIMONIAL_BODY_MAX, TESTIMONIAL_NOTE_MAX } from "./limits";

// Testimonials shown as social proof on the public booking page
// (docs/features/student-acquisition.md, D-24). This module
// owns the CRUD rules — field limits, teacher scoping, default sort. Callers
// handle their own cache revalidation and response shaping.
//
// TWO KINDS, and the difference is the point (see TestimonialSource in
// schema.prisma). `teacher_curated` is what this table has always held: the
// teacher's own transcription of something a student sent her privately. The
// platform cannot check it, so nothing here or on the public page claims it
// can. `student_submitted` is written by the signed-in student against a
// pairing the database can prove.
//
// The teacher-facing writes below therefore never touch a verified row's words.
// She can hide one (`published`) or delete it outright — both are hers to
// decide, and neither changes what the remaining text says. She cannot create
// one, and cannot edit one. Every teacher-side mutation here filters on
// `source: "teacher_curated"` for that reason; the database CHECK constraint
// backs it up so a missed filter cannot mint a fake badge.

// Re-exported, not re-declared. These used to be three literals here that
// ./limits believed it owned; see the warning in that file.
export { TESTIMONIAL_AUTHOR_MAX, TESTIMONIAL_NOTE_MAX, TESTIMONIAL_BODY_MAX } from "./limits";

// `authorNote` is optional; an empty string collapses to undefined so a blank
// field clears the note rather than storing "".
export const testimonialInputSchema = z.object({
  authorName: z.string().trim().min(1).max(TESTIMONIAL_AUTHOR_MAX),
  authorNote: z
    .string()
    .trim()
    .max(TESTIMONIAL_NOTE_MAX)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  body: z.string().trim().min(1).max(TESTIMONIAL_BODY_MAX),
});

export type TestimonialInput = z.infer<typeof testimonialInputSchema>;

export type TestimonialView = {
  id: string;
  authorName: string;
  authorNote: string | null;
  body: string;
  published: boolean;
  photoPath: string | null;
  source: TestimonialSource;
  verifiedAt: Date | null;
};

/** True for a testimonial the platform can vouch for. Read this rather than
 *  testing `verifiedAt` directly — the two columns move together by CHECK
 *  constraint, and a single predicate keeps every caller agreeing on which one
 *  is authoritative. */
export function isVerified(t: { source: TestimonialSource }): boolean {
  return t.source === "student_submitted";
}

// Fields selected from the DB for a TestimonialView. Used consistently across
// listTestimonials and addTestimonial so callers never miss
// a new column.
const testimonialSelect = {
  id: true,
  authorName: true,
  authorNote: true,
  body: true,
  published: true,
  photoPath: true,
  source: true,
  verifiedAt: true,
} as const;

/** All of a teacher's testimonials, in display order (sortOrder, then age). */
export function listTestimonials(teacherId: string): Promise<TestimonialView[]> {
  return prisma.testimonial.findMany({
    where: { teacherId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: testimonialSelect,
  });
}

/** Create a testimonial; new ones sort after existing ones by default.
 *  `photoPath` may be set immediately when the caller uploads a photo before
 *  creating the row, or null and updated later via setTestimonialPhoto. */
export async function addTestimonial(
  teacherId: string,
  input: TestimonialInput,
  photoPath?: string | null,
): Promise<TestimonialView> {
  const last = await prisma.testimonial.findFirst({
    where: { teacherId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return prisma.testimonial.create({
    data: {
      teacherId,
      authorName: input.authorName,
      authorNote: input.authorNote ?? null,
      body: input.body,
      sortOrder: (last?.sortOrder ?? 0) + 1,
      photoPath: photoPath ?? null,
      // Stated rather than left to the column default: this is the teacher's
      // own transcription, and it is the ONLY kind she can create.
      source: "teacher_curated",
    },
    select: testimonialSelect,
  });
}

/** Edit a testimonial's text, scoped to the owning teacher AND to her own
 * curated rows. Returns false when no matching row exists — which includes a
 * verified row she owns: editing a student's words is the one thing the badge
 * promises did not happen, so this refuses rather than silently rewriting.
 * `photoPath` when provided replaces the stored path (pass null to clear). */
export async function updateTestimonial(
  teacherId: string,
  id: string,
  input: TestimonialInput,
  photoPath?: string | null,
): Promise<boolean> {
  const data: Record<string, unknown> = {
    authorName: input.authorName,
    authorNote: input.authorNote ?? null,
    body: input.body,
  };
  if (photoPath !== undefined) {
    data.photoPath = photoPath;
  }
  const updated = await prisma.testimonial.updateMany({
    where: { id, teacherId, source: "teacher_curated" },
    data,
  });
  return updated.count > 0;
}

/** Clear only the photo from a testimonial (sets photoPath = null). Returns
 *  false when the row doesn't belong to this teacher, or is verified — a
 *  verified row's presentation is not hers to edit either. */
export async function clearTestimonialPhoto(teacherId: string, id: string): Promise<boolean> {
  const updated = await prisma.testimonial.updateMany({
    where: { id, teacherId, source: "teacher_curated" },
    data: { photoPath: null },
  });
  return updated.count > 0;
}

/** Show/hide a testimonial on the public page. Returns false when not found.
 *  Deliberately NOT filtered to curated rows: which testimonials appear on her
 *  own page stays entirely the teacher's call. Hiding one changes nothing about
 *  what the others say, so it costs the reader nothing. */
export async function setTestimonialPublished(
  teacherId: string,
  id: string,
  published: boolean,
): Promise<boolean> {
  const updated = await prisma.testimonial.updateMany({
    where: { id, teacherId },
    data: { published },
  });
  return updated.count > 0;
}

/** Delete a testimonial, scoped to the owning teacher. False when not found.
 *  Also unfiltered by source, for the same reason as the publish toggle. */
export async function deleteTestimonial(teacherId: string, id: string): Promise<boolean> {
  const deleted = await prisma.testimonial.deleteMany({ where: { id, teacherId } });
  return deleted.count > 0;
}

/**
 * Move one testimonial one place earlier or later in the public order.
 *
 * `sortOrder` is what the public booking page orders by, so it is the teacher's
 * only control over which quote a visitor reads first — and until now nothing
 * in either client could change it. Add assigns `max + 1`, which means the
 * column is dense-ish but never guaranteed: rows can share a value (two adds
 * racing read the same max) and gaps open when a row in the middle is deleted.
 *
 * So this does NOT swap two `sortOrder` values, which silently does nothing
 * when the pair happens to be tied. It reads the list in the same
 * `[sortOrder, createdAt]` order the readers use, moves the row one position
 * within that array, and rewrites every row's `sortOrder` to its index — one
 * transaction, so a reader never sees a half-renumbered list. Renumbering the
 * whole list is affordable precisely because it is short (a teacher's
 * testimonials, not a feed) and it leaves the column canonical afterwards.
 *
 * Returns false when the row isn't this teacher's, or when it is already at the
 * end it was asked to move towards — the caller treats that as a no-op, not an
 * error, because the arrow that produced it is disabled in the UI anyway.
 */
export async function moveTestimonial(
  teacherId: string,
  id: string,
  direction: "up" | "down",
): Promise<boolean> {
  const rows = await prisma.testimonial.findMany({
    where: { teacherId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  const from = rows.findIndex((row) => row.id === id);
  if (from === -1) return false;

  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= rows.length) return false;

  const reordered = [...rows];
  [reordered[from], reordered[to]] = [reordered[to], reordered[from]];

  await prisma.$transaction(
    reordered.map((row, index) =>
      prisma.testimonial.updateMany({
        where: { id: row.id, teacherId },
        data: { sortOrder: index },
      }),
    ),
  );
  return true;
}

// ---------- student-submitted (verified) ----------

/** The student's own submission. Same length limits as the curated form, minus
 *  the fields that only make sense when someone is writing ABOUT a third party:
 *  the author name and photo come from the Student row, and the note is a
 *  derived fact (class count) rather than free text, so neither is accepted
 *  here. There is nothing in this payload a teacher could use to dress a quote
 *  up as someone it is not. */
export const studentTestimonialInputSchema = z.object({
  body: z.string().trim().min(1).max(TESTIMONIAL_BODY_MAX),
});

export type StudentTestimonialInput = z.infer<typeof studentTestimonialInputSchema>;

/**
 * Create or replace the testimonial a student has written about one teacher.
 *
 * Upsert rather than insert: the partial unique index allows one row per
 * (teacher, student), and a student revising their own words is the same claim
 * restated, not a second one. `verifiedAt` moves with each write because it
 * timestamps the text that is actually on the page — stamping it once at first
 * submission would date a paragraph written months later.
 *
 * `authorName` is copied from the Student row rather than accepted from the
 * form so the displayed name is the one the teacher already has on her roster.
 * The caller is responsible for having established eligibility
 * (testimonialEligibility) — this function trusts studentId and teacherId.
 */
export async function upsertStudentTestimonial(
  teacherId: string,
  studentId: string,
  authorName: string,
  input: StudentTestimonialInput,
): Promise<TestimonialView> {
  const existing = await prisma.testimonial.findFirst({
    where: { teacherId, studentId },
    select: { id: true },
  });
  if (existing) {
    return prisma.testimonial.update({
      where: { id: existing.id },
      data: { body: input.body, authorName, verifiedAt: new Date() },
      select: testimonialSelect,
    });
  }
  const last = await prisma.testimonial.findFirst({
    where: { teacherId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return prisma.testimonial.create({
    data: {
      teacherId,
      studentId,
      authorName,
      body: input.body,
      // Published on arrival. The alternative — holding it for teacher approval
      // — would quietly rebuild the thing being fixed: a page showing only the
      // verified quotes its owner liked is curated again, just with extra
      // steps. She can still hide any single one, which is a visible act on a
      // row she can see, not a default that silently filters the set.
      published: true,
      sortOrder: (last?.sortOrder ?? 0) + 1,
      source: "student_submitted",
      verifiedAt: new Date(),
    },
    select: testimonialSelect,
  });
}

/** The testimonial this student has already written for this teacher, if any —
 *  so the portal can show them their own words and let them revise. */
export function findStudentTestimonial(
  teacherId: string,
  studentId: string,
): Promise<TestimonialView | null> {
  return prisma.testimonial.findFirst({
    where: { teacherId, studentId },
    select: testimonialSelect,
  });
}

/** A student withdrawing their own testimonial. Distinct from the teacher's
 *  delete: this one is scoped by studentId, so it can only ever reach the row
 *  the student themselves wrote. */
export async function deleteStudentTestimonial(
  teacherId: string,
  studentId: string,
): Promise<boolean> {
  const deleted = await prisma.testimonial.deleteMany({ where: { teacherId, studentId } });
  return deleted.count > 0;
}
