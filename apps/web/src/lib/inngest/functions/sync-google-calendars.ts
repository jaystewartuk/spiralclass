import { inngest } from "../client";
import { syncAllConnectedTeachers } from "@/lib/calendar/google/sync";

// Hourly (was */15 until D-115 — see lib/notifications/reminder-scan.ts for
// the Neon wake-grid arithmetic): for each teacher who connected their Google
// Calendar, pull
// their external busy times into google_busy_intervals so slot generation
// won't offer a slot over a personal event. No-ops cleanly when no teacher is
// connected (or the feature is dormant), the same shape as the other polling
// crons (poll-wise-statements).
//
// retries:1 — a transient Google 5xx gets one more shot; the next tick would
// catch it anyway, and each teacher's sync replaces their intervals wholesale
// so a double-run is idempotent. Per-teacher failures are recorded on the row
// (lastSyncError) and never abort the batch.

type StepRunner = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

// Exported for unit testing — drives the sync with a fake step runner.
export async function syncGoogleCalendarsHandler({ step }: { step: StepRunner }) {
  return step.run("sync-google-calendars", () => syncAllConnectedTeachers());
}

export const syncGoogleCalendarsCronFn = inngest.createFunction(
  {
    id: "sync-google-calendars-cron",
    retries: 1,
    triggers: [{ cron: "0 * * * *" }],
  },
  syncGoogleCalendarsHandler,
);
