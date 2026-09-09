import "server-only";

import type { Assignment, Prisma, Student, Teacher } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiAuthError } from "@/lib/api/auth";
import { studentIdentityIds } from "@/lib/students/identity";

// Resolve an assignment a STUDENT is authorized to see, and the concrete
// Student id (within the caller's identity set) that owns the booking. Ownership
// is the same gate every student booking route uses: the assignment's booking
// must belong to a Student row sharing the caller's email. Throws 404
// `assignment-not-found` on any miss so we never leak another student's work.
export async function resolveStudentAssignment(
  student: Student,
  assignmentId: string,
): Promise<{ assignment: Assignment; studentId: string }> {
  const identityIds = await studentIdentityIds(student);
  const assignment = await prisma.assignment.findFirst({
    where: {
      id: assignmentId,
      booking: { studentId: { in: identityIds } },
    },
  });
  if (!assignment) throw new ApiAuthError(404, "assignment-not-found");

  // The specific Student row this class belongs to — the submission is keyed to
  // it, not to whichever sibling identity happened to make the API call.
  const booking = await prisma.booking.findUnique({
    where: { id: assignment.bookingId },
    select: { studentId: true },
  });
  if (!booking) throw new ApiAuthError(404, "assignment-not-found");

  return { assignment, studentId: booking.studentId };
}

// Resolve an assignment a TEACHER owns (tenant scope). Throws 404 on any miss.
export async function resolveTeacherAssignment(
  teacher: Teacher,
  assignmentId: string,
): Promise<Assignment> {
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, teacherId: teacher.id },
  });
  if (!assignment) throw new ApiAuthError(404, "assignment-not-found");
  return assignment;
}

type TeacherAttemptResult = Prisma.HomeworkAttemptGetPayload<{
  include: {
    submission: { include: { assignment: true } };
    files: true;
    aiReviewDrafts: true;
  };
}>;

// Resolve a HomeworkAttempt a TEACHER owns (tenant scope, via the submission's
// denormalized teacherId — the same column every other homework table scopes
// on). Throws 404 on any miss. Includes the parent submission, assignment (for
// the ids/title a feedback route needs to enqueue a notification), files (for
// the AI review prompt), and this attempt's AI review draft history.
export async function resolveTeacherAttempt(
  teacher: Teacher,
  attemptId: string,
): Promise<TeacherAttemptResult> {
  const attempt = await prisma.homeworkAttempt.findFirst({
    where: { id: attemptId, submission: { teacherId: teacher.id } },
    include: {
      submission: { include: { assignment: true } },
      files: true,
      aiReviewDrafts: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!attempt) throw new ApiAuthError(404, "attempt-not-found");
  return attempt;
}
