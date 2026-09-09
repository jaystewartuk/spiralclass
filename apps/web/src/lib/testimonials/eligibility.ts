import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";

// Who may write a verified testimonial, and what the badge beside it is allowed
// to say.
//
// The platform is the system of record for the lesson, so unlike a review site
// it never has to infer whether a reviewer is real: it knows which student sat
// in which class with which teacher. This module is the single place that turns
// that record into the two answers the feature needs — "may this person write
// one" and "how many classes has this person actually taken" — so the write
// path and the public page can never disagree about a student's standing.

/**
 * Completed classes are the unit, not bookings.
 *
 * A `scheduled` booking is an intention and a cancelled one is a non-event;
 * neither is grounds for an opinion about the teaching. `no_show` is
 * deliberately excluded too — the class was consumed against the package and
 * the teacher was owed for it, but the student was not taught, so it cannot
 * count toward "classes with her".
 */
const COMPLETED = { status: "completed" } as const;

/** One completed class is the floor. It is a low bar on purpose: the badge's
 *  claim is "this person really is a student of hers", which is true after one
 *  lesson, and a higher threshold would only mean fewer true statements. The
 *  count travels with the badge so a reader can weigh one class against forty
 *  themselves. */
export const MIN_COMPLETED_CLASSES_TO_TESTIFY = 1;

export type TestimonialEligibility = {
  /** The Student row the testimonial would be written by — teacher-scoped by
   *  construction, so it pins the quote to this pairing. Null when the signed-in
   *  person has no pairing with this teacher at all. */
  studentId: string | null;
  completedClasses: number;
  eligible: boolean;
};

/**
 * Can this signed-in student write a testimonial for this teacher?
 *
 * Resolves across the student's whole identity set (one Student row per
 * (teacher, email) — see lib/students/identity.ts), then narrows to the single
 * row paired with THIS teacher. That row's id is what gets stored, which is why
 * a testimonial can never be moved between teachers after the fact.
 */
export async function testimonialEligibility(
  student: { id: string; email: string | null },
  teacherId: string,
): Promise<TestimonialEligibility> {
  const identityIds = await studentIdentityIds(student);
  const pairing = await prisma.teacherStudent.findFirst({
    where: { teacherId, studentId: { in: identityIds } },
    select: { studentId: true },
  });
  if (!pairing) return { studentId: null, completedClasses: 0, eligible: false };

  const completedClasses = await prisma.booking.count({
    where: { teacherId, studentId: pairing.studentId, ...COMPLETED },
  });
  return {
    studentId: pairing.studentId,
    completedClasses,
    eligible: completedClasses >= MIN_COMPLETED_CLASSES_TO_TESTIFY,
  };
}

/**
 * Completed-class counts for the students behind a set of verified
 * testimonials, keyed by student id.
 *
 * Derived at render time rather than stored on the testimonial, deliberately:
 * a number copied into the row at submission time starts drifting the next
 * lesson, and a badge that reads "12 classes" when the database says 40 is a
 * small lie in the one place the whole feature is asking to be believed. One
 * grouped query keeps that honest without an N+1.
 */
export async function completedClassCounts(
  teacherId: string,
  studentIds: readonly string[],
): Promise<Map<string, number>> {
  if (studentIds.length === 0) return new Map();
  const rows = await prisma.booking.groupBy({
    by: ["studentId"],
    where: { teacherId, studentId: { in: [...studentIds] }, ...COMPLETED },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.studentId, r._count._all]));
}
