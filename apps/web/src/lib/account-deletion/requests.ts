import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Self-serve deletion grace period: the anonymizer cron only picks up rows
// whose `scheduledFor` has matured, so the user has this long to cancel.
// Single source of truth for the web server actions.
export const DELETION_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

// Deletion is blocked while any of the subject's packages is still active
// with classes left to use: deleting would strand paid-for sessions and drag
// the platform into consumer-rights disputes it can't mediate. Teacher and
// student paths share the same rule, keyed by their respective owner column.
export async function teacherHasUnusedActivePackages(
  teacherId: string,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const count = await db.package.count({
    where: {
      teacherId,
      status: "active",
      classesUsed: { lt: db.package.fields.classesTotal },
    },
  });
  return count > 0;
}

export async function studentsHaveUnusedActivePackages(
  studentIds: string[],
  db: PrismaClient = prisma,
): Promise<boolean> {
  const count = await db.package.count({
    where: {
      studentId: { in: studentIds },
      status: "active",
      classesUsed: { lt: db.package.fields.classesTotal },
    },
  });
  return count > 0;
}

export async function pendingTeacherDeletionRequest(teacherId: string, db: PrismaClient = prisma) {
  return db.accountDeletionRequest.findFirst({
    where: { subjectType: "teacher", subjectId: teacherId, status: "pending" },
    orderBy: { scheduledFor: "asc" },
  });
}

// Idempotent: the partial unique index `account_deletion_one_pending_per_subject`
// already forbids a second pending row, so we skip when one exists rather than
// letting the insert throw. Returns whether a new row was created.
export async function fileTeacherDeletionRequest(
  input: { teacherId: string; email: string; scheduledFor: Date },
  db: PrismaClient = prisma,
): Promise<{ created: boolean }> {
  return db.$transaction(async (tx) => {
    const existing = await tx.accountDeletionRequest.findFirst({
      where: { subjectType: "teacher", subjectId: input.teacherId, status: "pending" },
      select: { id: true },
    });
    if (existing) return { created: false };
    await tx.accountDeletionRequest.create({
      data: {
        subjectType: "teacher",
        subjectId: input.teacherId,
        email: input.email,
        scheduledFor: input.scheduledFor,
      },
    });
    return { created: true };
  });
}

export async function cancelTeacherDeletionRequests(
  teacherId: string,
  db: PrismaClient = prisma,
): Promise<{ cancelled: number }> {
  const res = await db.accountDeletionRequest.updateMany({
    where: { subjectType: "teacher", subjectId: teacherId, status: "pending" },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return { cancelled: res.count };
}

// Deletion-request plumbing for the student self-serve path
// (docs/security.md), identity-set aware: a person's deletion
// request must cover EVERY Student row holding their data — the auth-linked
// row plus same-email siblings (studentComplianceIds), or the anonymizer
// would scrub one row while the others keep their name/email/phone.
//
// One AccountDeletionRequest row per Student row: the anonymization worker
// is keyed by subjectId and the partial unique index
// `account_deletion_one_pending_per_subject` already enforces one pending
// request per subject, so fan-out at request time needs no worker changes
// and stays idempotent (rows that already have a pending request are
// skipped).

export async function pendingStudentDeletionRequest(
  studentIds: string[],
  db: PrismaClient = prisma,
) {
  return db.accountDeletionRequest.findFirst({
    where: {
      subjectType: "student",
      subjectId: { in: studentIds },
      status: "pending",
    },
    orderBy: { scheduledFor: "asc" },
  });
}

export async function fileStudentDeletionRequests(
  input: { studentIds: string[]; email: string; scheduledFor: Date },
  db: PrismaClient = prisma,
): Promise<{ created: number }> {
  return db.$transaction(async (tx) => {
    const existing = await tx.accountDeletionRequest.findMany({
      where: {
        subjectType: "student",
        subjectId: { in: input.studentIds },
        status: "pending",
      },
      select: { subjectId: true },
    });
    const alreadyPending = new Set(existing.map((r) => r.subjectId));
    const toCreate = input.studentIds.filter((id) => !alreadyPending.has(id));
    if (toCreate.length > 0) {
      await tx.accountDeletionRequest.createMany({
        data: toCreate.map((subjectId) => ({
          subjectType: "student" as const,
          subjectId,
          email: input.email,
          scheduledFor: input.scheduledFor,
        })),
      });
    }
    return { created: toCreate.length };
  });
}

export async function cancelStudentDeletionRequests(
  studentIds: string[],
  db: PrismaClient = prisma,
): Promise<{ cancelled: number }> {
  const res = await db.accountDeletionRequest.updateMany({
    where: {
      subjectType: "student",
      subjectId: { in: studentIds },
      status: "pending",
    },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return { cancelled: res.count };
}
