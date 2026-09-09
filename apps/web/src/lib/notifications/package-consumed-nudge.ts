import type { PrismaClient } from "@prisma/client";
import { enqueuePackageConsumedStudent, enqueuePackageConsumedTeacher } from "./enqueue";
import { emitNotificationQueued } from "./events";
import { isCategoryEnabled, type NotificationPrefs } from "./preferences";

// Pure handler for the consumed-package renewal cron (notifications audit
// the renewal nudge). Finds active packages whose classes are fully committed
// (classesUsed >= classesTotal) where the student hasn't already started a
// follow-up package, and sends:
//   * the student a one-time "¿quieres renovar?" deep-linking to the
//     in-portal repurchase flow (/my-classes/buy), and
//   * the teacher a repeat-purchase heads-up so she can follow up
//     personally — the highest-converting channel this product has.
//
// The product's whole revenue model is "buy N classes, use them, buy again"
// (docs/decisions/D-03.md); this sweep is the automated half of that loop.
//
// Dedup is one nudge per package, ever, keyed off prior notification rows'
// metadata.packageId — same mechanism as the expiry nudge. The teacher row
// is always written (even when the student variant is preference-suppressed)
// so it anchors dedup for both.
//
// A package is NOT nudged while the same (teacher, student) pair has another
// package that can still absorb bookings: a pending checkout in flight, or an
// active package with unused, unexpired capacity. This deliberately does NOT
// key off purchase order — credit-ledger.ts draws from the soonest-to-expire
// eligible credit across a student's packages, not the newest one, so a
// package bought earlier can easily still have a balance while a later
// top-up runs dry first. A same-pairing repurchase is itself just another
// active/pending package with capacity, so this also covers "already
// renewed" without a separate check. Pending rows from abandoned checkouts
// only suppress until the cleanup cron expires them.

export type ConsumedNudgeDeps = {
  prisma: PrismaClient;
  // Injectable for tests; defaults to the real Inngest emit.
  emit?: (input: { notificationId: string; teacherId: string }) => Promise<void>;
  // Clock seam for tests.
  now?: Date;
};

export async function sendPackageConsumedNudges(
  deps: ConsumedNudgeDeps,
): Promise<{ ok: true; sent: number; skipped: number }> {
  const { prisma } = deps;
  const emit = deps.emit ?? emitNotificationQueued;
  const now = deps.now ?? new Date();

  // Fully committed = classesUsed has reached classesTotal (a column-to-
  // column comparison, hence the field reference). Disabled students are
  // skipped. Expiry date is irrelevant here: every class was used, so a
  // renewal nudge is appropriate whether or not time also ran out.
  const candidates = await prisma.package.findMany({
    where: {
      status: "active",
      classesUsed: { gte: prisma.package.fields.classesTotal },
      student: { disabledAt: null },
    },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      student: { select: { notificationPrefs: true } },
    },
  });
  if (candidates.length === 0) return { ok: true, sent: 0, skipped: 0 };

  // Archived (teacher-side "dar de baja") pairings are skipped — a cheap
  // pre-filter so we don't create rows just to suppress them. The dispatcher's
  // link-archived gate is the enforcing layer.
  const archivedKeys = new Set<string>();
  const teacherIds = [...new Set(candidates.map((c) => c.teacherId))];
  const studentIds = [...new Set(candidates.map((c) => c.studentId))];
  const archivedLinks = await prisma.teacherStudent.findMany({
    where: {
      archivedAt: { not: null },
      teacherId: { in: teacherIds },
      studentId: { in: studentIds },
    },
    select: { teacherId: true, studentId: true },
  });
  for (const l of archivedLinks) archivedKeys.add(`${l.teacherId}:${l.studentId}`);

  // Any other active (with unused, unexpired capacity) or pending package on
  // the same pairing means there's still somewhere for the student to book —
  // nothing to nudge. See the module comment for why this isn't keyed off
  // purchase order.
  const siblings = await prisma.package.findMany({
    where: {
      status: { in: ["active", "pending"] },
      teacherId: { in: teacherIds },
      studentId: { in: studentIds },
    },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      status: true,
      classesUsed: true,
      classesTotal: true,
      expiresAt: true,
    },
  });
  const hasAvailableSibling = (c: (typeof candidates)[number]): boolean =>
    siblings.some((s) => {
      if (s.id === c.id || s.teacherId !== c.teacherId || s.studentId !== c.studentId) {
        return false;
      }
      if (s.status === "pending") return true;
      return s.classesUsed < s.classesTotal && (s.expiresAt === null || s.expiresAt > now);
    });

  const eligible = candidates.filter(
    (c) => !archivedKeys.has(`${c.teacherId}:${c.studentId}`) && !hasAvailableSibling(c),
  );
  if (eligible.length === 0) return { ok: true, sent: 0, skipped: 0 };

  // Already-nudged set spans both variants: the teacher row is written
  // unconditionally, the student row only when prefs allow, so either one
  // marks the package as handled.
  const priorNudges = await prisma.notification.findMany({
    where: {
      templateName: { in: ["package_consumed_student", "package_consumed_teacher"] },
    },
    select: { metadata: true },
  });
  const alreadyNudged = new Set<string>();
  for (const n of priorNudges) {
    const pid = (n.metadata as { packageId?: string } | null)?.packageId;
    if (pid) alreadyNudged.add(pid);
  }

  let sent = 0;
  let skipped = 0;
  for (const pkg of eligible) {
    if (alreadyNudged.has(pkg.id)) {
      skipped += 1;
      continue;
    }
    // The student variant respects the same category gate as the expiry
    // nudge. Decide it up front so the teacher email can tell the truth about
    // whether the student actually got a notice (imported / opted-out students
    // get nothing). Pre-filtering also avoids creating rows just to suppress
    // them; the dispatcher enforces the same gate as a safety net.
    const studentNotified = isCategoryEnabled(
      pkg.student.notificationPrefs as NotificationPrefs | null,
      "expiry_reminders",
    );

    const teacherNotifId = await enqueuePackageConsumedTeacher(prisma, {
      teacherId: pkg.teacherId,
      studentId: pkg.studentId,
      packageId: pkg.id,
      studentNotified,
    });
    await emit({ notificationId: teacherNotifId, teacherId: pkg.teacherId });

    if (studentNotified) {
      const studentNotifId = await enqueuePackageConsumedStudent(prisma, {
        teacherId: pkg.teacherId,
        studentId: pkg.studentId,
        packageId: pkg.id,
      });
      await emit({ notificationId: studentNotifId, teacherId: pkg.teacherId });
    }
    sent += 1;
  }

  return { ok: true, sent, skipped };
}
