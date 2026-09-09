import type { PrismaClient } from "@prisma/client";
import { enqueuePackageExpiryNudge } from "./enqueue";
import { emitNotificationQueued } from "./events";
import { isCategoryEnabled, type NotificationPrefs } from "./preferences";

// Pure handler for the pre-expiry nudge cron. Finds active packages that
// expire within the window and still have unused classes, and sends the
// student a one-time "book before they lapse" nudge — recovering classes
// (and the rebooking) that would otherwise be silently forfeited.
//
// Dedup is one nudge per package, ever: there's no packageId column on
// notifications (it lives in metadata), so we collect already-nudged ids
// into a set and skip them. That makes the daily cron safe to re-run.

const DAY_MS = 24 * 60 * 60 * 1000;

export type ExpiryNudgeDeps = {
  prisma: PrismaClient;
  // Injectable for tests; defaults to the real Inngest emit.
  emit?: (input: { notificationId: string; teacherId: string }) => Promise<void>;
  // Days-ahead window for "expiring soon". Default 7.
  windowDays?: number;
  // Clock seam for tests.
  now?: Date;
};

export async function sendPackageExpiryNudges(
  deps: ExpiryNudgeDeps,
): Promise<{ ok: true; sent: number; skipped: number }> {
  const { prisma } = deps;
  const emit = deps.emit ?? emitNotificationQueued;
  const now = deps.now ?? new Date();
  const windowEnd = new Date(now.getTime() + (deps.windowDays ?? 7) * DAY_MS);

  // A null expiresAt never satisfies the gte/lte bounds, so no-expiry
  // packages are excluded automatically. Disabled students are skipped.
  const candidates = await prisma.package.findMany({
    where: {
      status: "active",
      expiresAt: { gte: now, lte: windowEnd },
      student: { disabledAt: null },
    },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      classesTotal: true,
      classesUsed: true,
      student: { select: { notificationPrefs: true } },
    },
  });

  // Archived (teacher-side "dar de baja") pairings are skipped — a cheap
  // pre-filter so we don't create rows just to suppress them. The dispatcher's
  // link-archived gate is the enforcing layer; this keeps the sweep from doing
  // needless work. Look up archived links among the candidate teachers/students
  // and exclude by exact (teacherId, studentId) key.
  const archivedKeys = new Set<string>();
  if (candidates.length > 0) {
    const archivedLinks = await prisma.teacherStudent.findMany({
      where: {
        archivedAt: { not: null },
        teacherId: { in: [...new Set(candidates.map((c) => c.teacherId))] },
        studentId: { in: [...new Set(candidates.map((c) => c.studentId))] },
      },
      select: { teacherId: true, studentId: true },
    });
    for (const l of archivedLinks) archivedKeys.add(`${l.teacherId}:${l.studentId}`);
  }

  // Eligible = active pairing AND unused classes remain AND the student wants
  // expiry reminders. The prefs check excludes CSV-imported students
  // (backfilled all-off) and anyone who turned the category off. The dispatcher
  // enforces the same gates as a safety net; pre-filtering here avoids creating
  // rows just to suppress them.
  const eligible = candidates.filter(
    (p) =>
      !archivedKeys.has(`${p.teacherId}:${p.studentId}`) &&
      p.classesUsed < p.classesTotal &&
      isCategoryEnabled(
        p.student.notificationPrefs as NotificationPrefs | null,
        "expiry_reminders",
      ),
  );
  if (eligible.length === 0) return { ok: true, sent: 0, skipped: 0 };

  const priorNudges = await prisma.notification.findMany({
    where: { templateName: "package_expiry_nudge" },
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
    const notificationId = await enqueuePackageExpiryNudge(prisma, {
      teacherId: pkg.teacherId,
      studentId: pkg.studentId,
      packageId: pkg.id,
    });
    await emit({ notificationId, teacherId: pkg.teacherId });
    sent += 1;
  }

  return { ok: true, sent, skipped };
}
