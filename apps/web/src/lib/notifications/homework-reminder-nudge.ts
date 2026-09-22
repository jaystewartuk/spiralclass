import type { PrismaClient } from "@prisma/client";
import { enqueueHomeworkDueSoon, enqueueHomeworkOverdue } from "./enqueue";
import { emitNotificationQueued } from "./events";
import { isCategoryEnabled, type NotificationPrefs } from "./preferences";

// Pure handlers for the due-soon/overdue homework reminder crons
// (docs/features/homework.md). Mirrors
// package-expiry-nudge.ts's shape: find eligible assignments, dedup by
// assignmentId against prior nudges (one per assignment, ever — safe to
// re-run daily), respect the student's "class_materials" preference (same
// category as the rest of the homework lifecycle) and archived-pairing gate.
//
// "Eligible" for BOTH nudges = the student hasn't submitted yet: no
// HomeworkSubmission row, or one still in `draft`. Once `submitted` (or later
// `returned`/`graded`) the assignment is no longer nag-worthy.

const HOUR_MS = 60 * 60 * 1000;

export type HomeworkReminderDeps = {
  prisma: PrismaClient;
  emit?: (input: { notificationId: string; teacherId: string }) => Promise<void>;
  now?: Date;
};

async function unsubmittedAssignmentCandidates(
  prisma: PrismaClient,
  dueAt: { gte: Date; lte: Date } | { lt: Date },
) {
  return prisma.assignment.findMany({
    where: {
      dueAt,
      booking: { student: { disabledAt: null } },
      OR: [{ submissions: { none: {} } }, { submissions: { some: { status: "draft" } } }],
    },
    select: {
      id: true,
      title: true,
      teacherId: true,
      bookingId: true,
      booking: { select: { studentId: true } },
    },
  });
}

async function archivedPairingKeys(
  prisma: PrismaClient,
  candidates: { teacherId: string; booking: { studentId: string } }[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (candidates.length === 0) return keys;
  const links = await prisma.teacherStudent.findMany({
    where: {
      archivedAt: { not: null },
      teacherId: { in: [...new Set(candidates.map((c) => c.teacherId))] },
      studentId: { in: [...new Set(candidates.map((c) => c.booking.studentId))] },
    },
    select: { teacherId: true, studentId: true },
  });
  for (const l of links) keys.add(`${l.teacherId}:${l.studentId}`);
  return keys;
}

async function alreadyNudgedAssignmentIds(
  prisma: PrismaClient,
  templateName: "homework_due_soon_student" | "homework_overdue_student",
): Promise<Set<string>> {
  const prior = await prisma.notification.findMany({
    where: { templateName },
    select: { metadata: true },
  });
  const ids = new Set<string>();
  for (const n of prior) {
    const id = (n.metadata as { assignmentId?: string } | null)?.assignmentId;
    if (id) ids.add(id);
  }
  return ids;
}

// Due-soon: assignments whose dueAt falls within [now, now + windowHours],
// nudged once. Default 24h window, matching the doc's suggested cadence.
export async function sendHomeworkDueSoonNudges(
  deps: HomeworkReminderDeps & { windowHours?: number },
): Promise<{ ok: true; sent: number; skipped: number }> {
  const { prisma } = deps;
  const emit = deps.emit ?? emitNotificationQueued;
  const now = deps.now ?? new Date();
  const windowEnd = new Date(now.getTime() + (deps.windowHours ?? 24) * HOUR_MS);

  const candidates = await unsubmittedAssignmentCandidates(prisma, { gte: now, lte: windowEnd });
  return sendNudges(prisma, emit, candidates, "homework_due_soon_student", enqueueHomeworkDueSoon);
}

// Overdue: assignments whose dueAt has already passed, nudged once —
// regardless of allowLateSubmission (surfacing the miss, not gating it).
export async function sendHomeworkOverdueNudges(
  deps: HomeworkReminderDeps,
): Promise<{ ok: true; sent: number; skipped: number }> {
  const { prisma } = deps;
  const emit = deps.emit ?? emitNotificationQueued;
  const now = deps.now ?? new Date();

  const candidates = await unsubmittedAssignmentCandidates(prisma, { lt: now });
  return sendNudges(prisma, emit, candidates, "homework_overdue_student", enqueueHomeworkOverdue);
}

type Candidate = {
  id: string;
  title: string;
  teacherId: string;
  bookingId: string;
  booking: { studentId: string };
};

async function sendNudges(
  prisma: PrismaClient,
  emit: (input: { notificationId: string; teacherId: string }) => Promise<void>,
  candidates: Candidate[],
  templateName: "homework_due_soon_student" | "homework_overdue_student",
  enqueue: (
    tx: PrismaClient,
    input: { studentId: string; teacherId: string; bookingId: string; assignmentId: string },
  ) => Promise<string>,
): Promise<{ ok: true; sent: number; skipped: number }> {
  if (candidates.length === 0) return { ok: true, sent: 0, skipped: 0 };

  const archivedKeys = await archivedPairingKeys(prisma, candidates);
  const studentIds = [...new Set(candidates.map((c) => c.booking.studentId))];
  const students = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, notificationPrefs: true },
  });
  const prefsById = new Map(
    students.map((s) => [s.id, s.notificationPrefs as NotificationPrefs | null]),
  );

  const eligible = candidates.filter(
    (c) =>
      !archivedKeys.has(`${c.teacherId}:${c.booking.studentId}`) &&
      isCategoryEnabled(prefsById.get(c.booking.studentId) ?? null, "class_materials"),
  );
  if (eligible.length === 0) return { ok: true, sent: 0, skipped: 0 };

  const alreadyNudged = await alreadyNudgedAssignmentIds(prisma, templateName);

  let sent = 0;
  let skipped = 0;
  for (const a of eligible) {
    if (alreadyNudged.has(a.id)) {
      skipped += 1;
      continue;
    }
    const notificationId = await enqueue(prisma, {
      studentId: a.booking.studentId,
      teacherId: a.teacherId,
      bookingId: a.bookingId,
      assignmentId: a.id,
    });
    await emit({ notificationId, teacherId: a.teacherId });
    sent += 1;
  }

  return { ok: true, sent, skipped };
}
