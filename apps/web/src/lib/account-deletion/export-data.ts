import type { PrismaClient } from "@prisma/client";

// Self-serve data export (audit MED-6) — the "access" half of ARCO /
// GDPR rights to complement the existing deletion path. Returns a plain
// JSON-serialisable snapshot of everything we hold that is *about* the
// subject. Read-only: no mutation, no side effects.
//
// Scope decisions:
//   * Teacher export covers their profile, payment-rail config (Stripe /
//     Wise identifiers, never secrets — we never store Stripe secrets),
//     their roster links, package/booking/payment history, and templates.
//   * Student export covers their profile, consent flags, the teachers
//     they're linked to, and their package/booking/payment history.
//   * We expose the data the subject provided or that was generated about
//     them; we do not include other users' PII (e.g. a teacher export
//     lists student ids, not student emails — each student exports their
//     own copy).

type Db = Pick<PrismaClient, "teacher" | "student">;

export type ExportEnvelope = {
  exportedAt: string;
  subjectType: "teacher" | "student";
  subjectId: string;
  data: unknown;
};

export async function buildTeacherExport(
  db: Db,
  teacherId: string,
): Promise<ExportEnvelope | null> {
  const teacher = await db.teacher.findUnique({
    where: { id: teacherId },
    select: {
      id: true,
      email: true,
      name: true,
      timezone: true,
      bufferMin: true,
      minAdvanceH: true,
      maxAdvanceDays: true,
      bookingSlug: true,
      onboardingCompleteAt: true,
      phoneE164: true,
      stripeAccountId: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      wisePaymentsEnabled: true,
      wiseHandle: true,
      wiseAccountHolder: true,
      wiseEmail: true,
      disabledAt: true,
      createdAt: true,
      packageTemplates: {
        select: {
          id: true,
          name: true,
          classCount: true,
          classDurationMin: true,
          priceMinorUnits: true,
          transferPriceMinorUnits: true,
          expirationMonths: true,
          archived: true,
          createdAt: true,
        },
      },
      teacherStudents: {
        select: {
          studentId: true,
          // Grandfathering, per package since 2026-09-01.
          templatePrices: {
            select: { templateId: true, priceMinorUnits: true, currency: true },
          },
          customPriceNote: true,
          // Teacher-authored durable student profile (D-20, Layer 1) — the
          // teacher's own content, like customPriceNote: included here, never in
          // the student export.
          interests: true,
          goals: true,
          createdAt: true,
        },
      },
      // Teacher-private notes about students are the teacher's own content, so
      // they belong in the teacher export — but never in the student export
      // (the notes are not shown to students), mirroring custom_price_note.
      studentNotes: {
        select: { studentId: true, body: true, createdAt: true, updatedAt: true },
      },
      packages: {
        select: {
          id: true,
          studentId: true,
          classesTotal: true,
          classesUsed: true,
          pricePaidMinorUnits: true,
          status: true,
          purchasedAt: true,
          expiresAt: true,
          payments: {
            select: {
              id: true,
              amountMinorUnits: true,
              status: true,
              provider: true,
              createdAt: true,
              paidAt: true,
              refundedAt: true,
            },
          },
        },
      },
      bookings: {
        select: {
          id: true,
          studentId: true,
          scheduledStart: true,
          scheduledEnd: true,
          status: true,
          completedAt: true,
          createdAt: true,
        },
      },
    },
  });
  if (!teacher) return null;
  return {
    exportedAt: new Date().toISOString(),
    subjectType: "teacher",
    subjectId: teacher.id,
    data: teacher,
  };
}

// Identity-set export: a person's ARCO/GDPR access right covers every
// Student row holding their data — the auth-linked row plus same-email
// siblings, including moderated rows (callers pass studentComplianceIds).
// One per-row snapshot each, so the per-teacher scoping of packages,
// bookings and consent stays legible in the export.
export async function buildStudentIdentityExport(
  db: Db,
  studentIds: string[],
): Promise<ExportEnvelope | null> {
  const rows = [];
  for (const id of studentIds) {
    const row = await buildStudentExport(db, id);
    if (row) rows.push(row.data);
  }
  if (rows.length === 0) return null;
  return {
    exportedAt: new Date().toISOString(),
    subjectType: "student",
    subjectId: studentIds[0],
    data: rows.length === 1 ? rows[0] : { identityRows: rows },
  };
}

export async function buildStudentExport(
  db: Db,
  studentId: string,
): Promise<ExportEnvelope | null> {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      email: true,
      name: true,
      phoneE164: true,
      timezone: true,
      locale: true,
      emailOptIn: true,
      emailOptInAt: true,
      disabledAt: true,
      createdAt: true,
      teacherStudents: {
        select: { teacherId: true, createdAt: true },
      },
      packages: {
        select: {
          id: true,
          teacherId: true,
          classesTotal: true,
          classesUsed: true,
          pricePaidMinorUnits: true,
          status: true,
          purchasedAt: true,
          expiresAt: true,
          payments: {
            select: {
              id: true,
              amountMinorUnits: true,
              status: true,
              provider: true,
              createdAt: true,
              paidAt: true,
              refundedAt: true,
            },
          },
        },
      },
      bookings: {
        select: {
          id: true,
          teacherId: true,
          scheduledStart: true,
          scheduledEnd: true,
          status: true,
          completedAt: true,
          createdAt: true,
        },
      },
    },
  });
  if (!student) return null;
  return {
    exportedAt: new Date().toISOString(),
    subjectType: "student",
    subjectId: student.id,
    data: student,
  };
}
