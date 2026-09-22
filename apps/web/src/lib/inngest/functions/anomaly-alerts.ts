import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import { inngest } from "../client";
import { prisma } from "@/lib/prisma";

// docs/security.md.
//
// Hourly cron that scans the past hour for suspicious clusters and
// emits a Sentry warning when thresholds are crossed. The point is to
// catch a compromised teacher account dumping refunds before a human
// notices, and to flag moderation activity (disabled teachers /
// students) so we know about it without checking the audit log.
//
// Sentry routes warnings to the ops Resend list. Each alert
// carries a stable fingerprint so Sentry groups recurring spikes
// instead of paging on every hour they're elevated.

const WINDOW_MIN = 60;

// ── Detection thresholds ────────────────────────────────────────────────────
//
// ⚠️ **The values that actually run are environment configuration, not these
// defaults.** Publishing the live numbers tells anyone reading this file
// exactly how much of each abuse signal stays under the alarm — the one class
// of constant in this repo where being open source is a real cost. The defaults
// below keep the detector working on a fresh checkout; the deployed values are
// set per environment and are not in this tree.
//
// Each is "more than the busiest hour this platform has seen for that signal".
// Retune as traffic grows — in the environment, not here.
//
// Push-delivery failures need their own reasoning: they land on rows that still
// end status='sent' (email fallback), so the notification-failure threshold
// never sees them. A dead FCM credential makes EVERY push fail, while
// steady-state churn is rare (a dead token is revoked on its first
// DeviceNotRegistered, so it cannot recur) — so that threshold separates a
// systemic outage from noise rather than measuring a rate.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolved at call time so a deployment can retune without a rebuild, and so
 * the tests drive their boundary cases from the real values rather than
 * restating them as magic numbers.
 */
export function anomalyThresholds() {
  return {
    refund: envInt("ANOMALY_REFUND_THRESHOLD", 8),
    refundPerTeacher: envInt("ANOMALY_REFUND_PER_TEACHER_THRESHOLD", 4),
    teacherDisable: envInt("ANOMALY_TEACHER_DISABLE_THRESHOLD", 2),
    studentDisable: envInt("ANOMALY_STUDENT_DISABLE_THRESHOLD", 5),
    failedNotifications: envInt("ANOMALY_FAILED_NOTIFICATIONS_THRESHOLD", 40),
    failedPayments: envInt("ANOMALY_FAILED_PAYMENTS_THRESHOLD", 8),
    pushFailures: envInt("ANOMALY_PUSH_FAILURE_THRESHOLD", 15),
  };
}

type Anomaly = {
  fingerprint: string;
  message: string;
  level: "warning" | "error";
  extras: Record<string, unknown>;
};

export async function detectAnomalies(now: Date): Promise<Anomaly[]> {
  const t = anomalyThresholds();
  const windowStart = new Date(now.getTime() - WINDOW_MIN * 60_000);
  const anomalies: Anomaly[] = [];

  // 1. Refund spike (platform-wide).
  const refundCount = await prisma.payment.count({
    where: { status: "refunded", refundedAt: { gte: windowStart } },
  });
  if (refundCount >= t.refund) {
    anomalies.push({
      fingerprint: "anomaly:refund-spike-platform",
      message: `Refund spike: ${refundCount} refunds in the past ${WINDOW_MIN} min`,
      level: "warning",
      extras: { refundCount, windowMin: WINDOW_MIN },
    });
  }

  // 2. Per-teacher refund cluster — the signal we actually care about
  // for compromised-account detection. Group by package.teacher_id.
  const refundsByTeacher = await prisma.payment.findMany({
    where: { status: "refunded", refundedAt: { gte: windowStart } },
    select: { package: { select: { teacherId: true } } },
  });
  const byTeacher = new Map<string, number>();
  for (const r of refundsByTeacher) {
    const id = r.package.teacherId;
    byTeacher.set(id, (byTeacher.get(id) ?? 0) + 1);
  }
  for (const [teacherId, count] of byTeacher.entries()) {
    if (count >= t.refundPerTeacher) {
      anomalies.push({
        fingerprint: `anomaly:refund-spike-teacher:${teacherId}`,
        message: `Teacher refund cluster: ${count} refunds in the past ${WINDOW_MIN} min`,
        level: "error",
        extras: { teacherId, count, windowMin: WINDOW_MIN },
      });
    }
  }

  // 3. Moderation overrides in the window.
  const overrides = await prisma.override.findMany({
    where: {
      createdAt: { gte: windowStart },
      action: { in: ["disable_teacher", "disable_student"] },
    },
    select: { action: true, targetId: true, teacherId: true },
  });
  const teacherDisables = overrides.filter((o) => o.action === "disable_teacher");
  const studentDisables = overrides.filter((o) => o.action === "disable_student");
  if (teacherDisables.length >= t.teacherDisable) {
    anomalies.push({
      fingerprint: "anomaly:teacher-disabled",
      message: `Teacher(s) disabled in the past ${WINDOW_MIN} min`,
      level: "warning",
      extras: {
        count: teacherDisables.length,
        targets: teacherDisables.map((o) => o.targetId),
      },
    });
  }
  if (studentDisables.length >= t.studentDisable) {
    anomalies.push({
      fingerprint: "anomaly:student-disable-cluster",
      message: `Student-disable cluster: ${studentDisables.length} in the past ${WINDOW_MIN} min`,
      level: "warning",
      extras: { count: studentDisables.length },
    });
  }

  // 4. Notification failure rate — early warning that Meta or Resend
  // changed something on their side.
  const failedNotifications = await prisma.notification.count({
    where: { status: "failed", failedAt: { gte: windowStart } },
  });
  if (failedNotifications >= t.failedNotifications) {
    anomalies.push({
      fingerprint: "anomaly:notification-failure-rate",
      message: `Notification failure rate: ${failedNotifications} failed in the past ${WINDOW_MIN} min`,
      level: "warning",
      extras: { count: failedNotifications },
    });
  }

  // 5. Payment failure rate.
  const failedPayments = await prisma.payment.count({
    where: {
      status: "failed",
      // We don't have a failedAt; createdAt is a reasonable proxy because
      // a payment transitions to failed only after the webhook fires.
      createdAt: { gte: windowStart },
    },
  });
  if (failedPayments >= t.failedPayments) {
    anomalies.push({
      fingerprint: "anomaly:payment-failure-rate",
      message: `Payment failure rate: ${failedPayments} failed in the past ${WINDOW_MIN} min`,
      level: "warning",
      extras: { count: failedPayments },
    });
  }

  // 6. Push-delivery failure rate. The dispatcher records `metadata.pushError`
  // on every non-retryable push failure (bad/absent FCM credentials, all tokens
  // rejected) then falls back to email, so the row is status='sent' and anomaly
  // #4 above never catches it. This is the signal that was missing when the
  // 2026-07-07 FCM-credential outage silently downgraded every push to email.
  // Equivalent SQL: count(*) where metadata->>'pushError' is not null.
  const pushFailures = await prisma.notification.count({
    where: {
      createdAt: { gte: windowStart },
      metadata: { path: ["pushError"], not: Prisma.AnyNull },
    },
  });
  if (pushFailures >= t.pushFailures) {
    anomalies.push({
      fingerprint: "anomaly:push-delivery-failure-rate",
      message: `Push delivery failures: ${pushFailures} notifications hit a non-retryable push error in the past ${WINDOW_MIN} min (fell back to email)`,
      level: "error",
      extras: { count: pushFailures, windowMin: WINDOW_MIN },
    });
  }

  return anomalies;
}

function emitToSentry(a: Anomaly): void {
  Sentry.captureMessage(a.message, {
    level: a.level,
    fingerprint: [a.fingerprint],
    tags: { surface: "anomaly-alerts" },
    extra: a.extras,
  });
}

// The full cron body — detect, then emit each anomaly to Sentry — as a plain
// runner so both backends invoke identical logic (the Inngest wrapper below
// and the pg-boss cron definition in lib/jobs/crons.ts, during the Phase 1
// dual-run). Kept in this module so `emitToSentry` stays private.
export async function runAnomalyAlerts(now: Date = new Date()): Promise<{
  ok: true;
  count: number;
}> {
  const anomalies = await detectAnomalies(now);
  for (const a of anomalies) emitToSentry(a);
  return { ok: true, count: anomalies.length };
}

export const anomalyAlertsCronFn = inngest.createFunction(
  {
    id: "anomaly-alerts-cron",
    retries: 1,
    // On the hour, not at :05 — the old off-grid minute was the fleet's only
    // schedule that missed the shared :00/:15/:30/:45 grid, so it opened a
    // second 5-minute Neon wake window every hour all by itself (~15 CU-hours
    // a month for one job). See lib/env.ts's isPreviewDeployment.
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) => {
    return step.run("detect-and-alert", () => runAnomalyAlerts(new Date()));
  },
);
