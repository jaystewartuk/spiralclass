import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { enqueue } from "@/lib/jobs/enqueue";
import { scanAndScheduleNextWake } from "@/lib/notifications/reminder-scan";

// Reminders (docs/architecture/overview.md).
// Replaces the per-booking `sleepUntil` fan-out (former schedule-reminders) with
// a due-scan: find upcoming scheduled bookings whose 24h/1h/15m legs have come
// due and enqueue them (idempotent — see reminder-scan.ts). No durable
// multi-day timer remains, so nothing is orphaned at the Inngest→pg-boss
// cutover. Runs on the live backend now; mirrored as a pg-boss cron (crons.ts).
//
// Hourly, not `*/15` (D-115). Every tick is a DB touch and a touch buys a fixed
// 5 min of billed Neon compute, so `*/15` cost ~89 of the 100 free CU-hours a
// month for a fleet whose actual work is ~0.7 min per tick. The 15m leg — the
// only thing that ever needed a sub-hourly poll — is now served exactly by the
// wake chain instead: each run arms one delayed `reminder.due` at the precise
// moment the next leg comes due, and that wake re-enters the same scan
// (on-reminder-due.ts). The chain is also (re)started by a creation-time
// re-scan (on-booking-created.ts, on every `booking.created`), so a class
// booked between two hourly ticks still gets its 1h/15m legs on time instead
// of at the next tick — or never, if the class starts before it. Precision is
// unchanged; the polling is gone. This cron is the backstop for both.
//
// It was `*/5` (for a 5m leg) until 2026-08-08, which pinned the compute awake
// 24/7 — see lib/notifications/reminder-scan.ts for why no scheduling trick
// rescues a 5-minute leg, and lib/env.ts's isPreviewDeployment for the fleet
// arithmetic.
export const reminderScanCronFn = inngest.createFunction(
  {
    id: "reminder-scan-cron",
    retries: 1,
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) =>
    step.run("scan-due-reminders", () => scanAndScheduleNextWake({ prisma, enqueue })),
);
