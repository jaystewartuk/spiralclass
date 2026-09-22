import { inngest } from "@/lib/inngest/client";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { getEmailClient } from "@/lib/email";
import { getStorageProvider } from "@/lib/storage/provider";
import { runAnomalyAlerts } from "@/lib/inngest/functions/anomaly-alerts";
import { autoCompleteSweepHandler } from "@/lib/inngest/functions/auto-complete-sweep";
import { accountDeletionHandler } from "@/lib/inngest/functions/account-deletion";
import { reconcileWiseStatements } from "@/lib/payments/wise-reconcile";
import { wiseClientForTeacher } from "@/lib/wise/api";
import { reconcileStrandedPaidPayments } from "@/lib/payments/reconcile-paid";
import { cleanupAbandonedPendingPackages } from "@/lib/payments/cleanup-pending";
import { sendTransferConfirmReminders } from "@/lib/payments/transfer-confirm-reminder";
import { purgeExpiredMaterials } from "@/lib/storage/materials-purge";
import { syncAllConnectedTeachers } from "@/lib/calendar/google/sync";
import { runSubscriptionSweep } from "@/lib/subscriptions/sweep";
import { sendPackageExpiryNudges } from "@/lib/notifications/package-expiry-nudge";
import { sendPackageConsumedNudges } from "@/lib/notifications/package-consumed-nudge";
import { sendWeeklyPlanNudges } from "@/lib/notifications/weekly-plan-nudge";
import { sendPendingInviteNudges } from "@/lib/invitations/nudge";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { redispatchStaleQueuedNotifications } from "@/lib/notifications/redispatch-queued";
import { scanAndScheduleNextWake } from "@/lib/notifications/reminder-scan";
import { enqueue } from "./enqueue";
import type { JobDefinition } from "./register";

// Phase 1 of the Inngest → in-house migration
// (docs/architecture/overview.md). The 15 cron functions, ported to pg-boss
// `schedule()` definitions. Each handler calls the SAME pure logic the
// matching Inngest cron wraps, so under the Phase 1 dual-run
// (JOBS_BACKEND=pgboss while the Inngest crons are still registered) both
// backends run byte-identical work. Every handler is idempotent — row-level
// dedup, status guards, or a full no-op when nothing's connected — so a cron
// firing on both backends during the soak is safe by construction (the same
// property the audit relies on).
//
// Queue name = the Inngest function `id`, so the pg-boss `job` table reads
// like the audit's inventory. Cron patterns are copied verbatim from
// each Inngest `triggers: [{ cron }]`; the `crons.test.ts` schedule table
// pins them against drift. pg-boss schedules in UTC by default, matching the
// Inngest crons (whose comments are all UTC-relative).
//
// EMITS during Phase 1: the three crons that fan out domain events
// (`poll-wise`, `reconcile-paid`, `subscription-sweep`) still emit through
// `inngest.send`, because their consumers are Inngest-registered until
// Phase 2 moves event handlers onto the seam. Nudge crons enqueue
// notifications via `emitNotificationQueued` internally (also still Inngest
// today), so they need no `emit` wiring here. Phase 2 swaps both to the
// provider-agnostic `enqueue()` seam.

// pg-boss delivers jobs as a batch array; a cron job carries no meaningful
// payload, so every handler below ignores it. A zero-arg async fn is
// assignable to pg-boss's `WorkHandler` (`(job[]) => Promise<any>`).

// Shim matching the structural `{ run }` step runner that the two handlers
// still authored against an Inngest `step` accept — it just invokes the fn
// (no memoization/durability needed; the handler bodies are idempotent).
const stepShim = { run: <T>(_id: string, fn: () => T | Promise<T>) => Promise.resolve(fn()) };

// The `inngest.send` emitter, matching each Inngest cron wrapper's own `emit`
// callback exactly (see poll-wise-statements.ts / reconcile-paid-payments.ts /
// subscription-sweep.ts). Phase 2 replaces this with the `enqueue()` seam.
const emitViaInngest = async (event: { name: string; data: object }): Promise<void> => {
  await inngest.send(event as Parameters<typeof inngest.send>[0]);
};

export const cronJobs: JobDefinition[] = [
  {
    queue: "poll-wise-statements-cron",
    cron: { pattern: "0 * * * *" },
    handler: async () => {
      await reconcileWiseStatements({
        prisma,
        clientForTeacher: wiseClientForTeacher,
        emit: emitViaInngest,
      });
    },
  },
  {
    queue: "sync-google-calendars-cron",
    cron: { pattern: "0 * * * *" },
    handler: async () => {
      await syncAllConnectedTeachers();
    },
  },
  {
    queue: "reconcile-paid-payments-cron",
    cron: { pattern: "0 * * * *" },
    handler: async () => {
      await reconcileStrandedPaidPayments({ prisma, emit: emitViaInngest });
    },
  },
  {
    // Back to hourly (D-115). Phase 2b-ii had tightened this to */15 to keep
    // completion — and the earned/held cash-flow split that follows it — within
    // ~15 min of scheduledEnd; the quarter-hourly grid cost ~89 of the 100 free
    // Neon CU-hours a month fleet-wide, and this sweep moves no money.
    queue: "auto-complete-sweep-cron",
    cron: { pattern: "0 * * * *" },
    handler: async () => {
      await autoCompleteSweepHandler({ step: stepShim });
    },
  },
  {
    queue: "anomaly-alerts-cron",
    cron: { pattern: "0 * * * *" },
    handler: async () => {
      await runAnomalyAlerts(new Date());
    },
  },
  {
    queue: "account-deletion-cron",
    cron: { pattern: "0 4 * * *" },
    handler: async () => {
      await accountDeletionHandler({ step: stepShim });
    },
  },
  {
    queue: "subscription-sweep-cron",
    cron: { pattern: "0 14 * * *" },
    handler: async () => {
      await runSubscriptionSweep({ prisma, emit: emitViaInngest });
    },
  },
  {
    queue: "cleanup-pending-packages-cron",
    cron: { pattern: "0 3 * * *" },
    handler: async () => {
      await cleanupAbandonedPendingPackages({ prisma });
    },
  },
  {
    queue: "materials-purge-cron",
    cron: { pattern: "0 2 * * *" },
    handler: async () => {
      await purgeExpiredMaterials({ prisma, storage: getStorageProvider() });
    },
  },
  {
    queue: "package-expiry-nudge-cron",
    cron: { pattern: "0 15 * * *" },
    handler: async () => {
      await sendPackageExpiryNudges({ prisma });
    },
  },
  {
    queue: "package-consumed-nudge-cron",
    cron: { pattern: "0 17 * * *" },
    handler: async () => {
      await sendPackageConsumedNudges({ prisma });
    },
  },
  {
    queue: "wise-confirm-reminder-cron",
    cron: { pattern: "0 */6 * * *" },
    handler: async () => {
      await sendTransferConfirmReminders({ prisma });
    },
  },
  {
    queue: "weekly-plan-nudge-cron",
    cron: { pattern: "0 16 * * 1" },
    handler: async () => {
      await sendWeeklyPlanNudges({ prisma });
    },
  },
  {
    queue: "invitations-pending-nudge-cron",
    cron: { pattern: "0 15 * * *" },
    handler: async () => {
      await sendPendingInviteNudges({ prisma });
    },
  },
  {
    // Warm-up backstop (the audit): re-drive notifications stuck in
    // status='queued' after a lost post-commit emit.
    queue: "redispatch-queued-cron",
    cron: { pattern: "0 * * * *" },
    handler: async () => {
      await redispatchStaleQueuedNotifications({ prisma, emit: emitNotificationQueued });
    },
  },
  {
    // Reminders as a due-scan (Phase 2b-ii): replaces the per-booking
    // sleepUntil fan-out. Hourly as of D-115 — the 15m leg is served exactly by
    // the wake chain this arms, not by the grid (see reminder-scan.ts). On this
    // backend the wake is a delayed pg-boss job on the `reminder.due` queue
    // (lib/jobs/events.ts) — `startAfter`/`singletonKey` are pg-boss's own
    // options, and the `enqueue` seam maps them onto the event's `ts`/`id` when
    // it routes to Inngest instead, so one call site serves both backends.
    queue: "reminder-scan-cron",
    cron: { pattern: "0 * * * *" },
    handler: async () => {
      await scanAndScheduleNextWake({ prisma, enqueue });
    },
  },
];
