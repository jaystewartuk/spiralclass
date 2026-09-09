import type { PrismaClient, Student } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { defaultNewStudentNotificationPrefs } from "@/lib/notifications/preferences";

// Thrown instead of creating a new roster Student row when the checkout
// email already belongs to a Teacher account. Teacher and Student are
// mutually exclusive roles per email/auth identity (see
// docs/architecture/multi-teacher-students.md "Mutual exclusivity") — a
// teacher's own email purchasing a class would otherwise mint an orphaned
// roster row no auth identity can ever sign into (the matching auth user
// already owns the Teacher row, so resolveLinkedStudent refuses to link it).
export class TeacherEmailConflictError extends Error {
  constructor(email: string) {
    super(`Email ${email} belongs to a teacher account, not a student.`);
    this.name = "TeacherEmailConflictError";
  }
}

/**
 * The teacher's own "share progress with my students" policy — the value a new
 * pairing's `shareProgress` is created with. A missing teacher row can't
 * happen inside a checkout, but reading `?? false` rather than asserting keeps
 * the failure mode "not shared" instead of "throws mid-checkout".
 */
async function sharesProgressByDefault(
  tx: Pick<PrismaClient, "teacher">,
  teacherId: string,
): Promise<boolean> {
  const teacher = await tx.teacher.findUnique({
    where: { id: teacherId },
    select: { shareProgressByDefault: true },
  });
  return teacher?.shareProgressByDefault ?? false;
}

// Shared by the web and mobile public checkouts: resolve the (teacher, email)
// pair to exactly one roster Student, creating it on first purchase.
//
// `students.email` is deliberately non-unique (multi-teacher tenancy — see
// schema.prisma), so no schema constraint stops a double-submitted checkout
// from racing two find-then-create flows into two Student rows for the same
// person. The transaction-scoped advisory lock serializes checkouts per
// (teacher, normalized email): the second request waits, then finds the row
// the first one committed. The lock releases automatically at commit/rollback.
//
// Caller contract: `email` is already trimmed + lowercased (the checkout
// schemas normalize) and the platform-wide disabled check has already run.
export async function findOrCreateRosterStudent(
  input: {
    teacherId: string;
    email: string;
    name: string;
    phoneE164: string | null;
  },
  db: PrismaClient = prisma,
): Promise<Student> {
  return db.$transaction(async (tx) => {
    // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns void, so
    // there's no result column to deserialize — this is a statement, not a
    // query. The lock is held until the surrounding transaction ends.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`student-upsert:${input.teacherId}:${input.email}`}, 0))`;

    const existing = await tx.student.findFirst({
      where: {
        email: input.email,
        teacherStudents: { some: { teacherId: input.teacherId } },
      },
      // Deterministic if legacy duplicates exist: the oldest row is the one
      // minted by the person's first checkout, i.e. the one with history.
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    if (existing) {
      // A self-serve checkout is the student engaging with the app on their
      // own, so lift any silent-onboarding hold the teacher had on this
      // pairing — otherwise we'd suppress the student's own purchase
      // confirmation. (Funnel-created links below never set a hold.)
      await tx.teacherStudent.updateMany({
        where: {
          teacherId: input.teacherId,
          studentId: existing.id,
          onboardingHoldAt: { not: null },
        },
        data: { onboardingHoldAt: null },
      });
      return tx.student.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          ...(input.phoneE164 ? { phoneE164: input.phoneE164 } : {}),
        },
      });
    }

    const teacherConflict = await tx.teacher.findFirst({
      where: { email: { equals: input.email, mode: "insensitive" } },
      select: { id: true },
    });
    if (teacherConflict) throw new TeacherEmailConflictError(input.email);

    return tx.student.create({
      data: {
        email: input.email,
        name: input.name,
        // No explicit locale — the column default ("en") applies. The public
        // checkout funnel a student just came through is English on purpose
        // (students are English learners), so stamping every new roster row
        // es-MX contradicted the surface that created it, and sent that
        // student Spanish class reminders forever after.
        phoneE164: input.phoneE164,
        notificationPrefs: defaultNewStudentNotificationPrefs(),
        // A new pairing inherits the teacher's own sharing policy. Read inside
        // the transaction rather than passed in by the caller: every entry
        // point that mints a student (checkout, funnel, invitation) would
        // otherwise have to remember to, and the one that forgot would silently
        // create a student the booking page had already promised progress to.
        teacherStudents: {
          create: {
            teacherId: input.teacherId,
            shareProgress: await sharesProgressByDefault(tx, input.teacherId),
          },
        },
      },
    });
  });
}
