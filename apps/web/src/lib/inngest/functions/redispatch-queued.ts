import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { redispatchStaleQueuedNotifications } from "@/lib/notifications/redispatch-queued";

// Warm-up backstop (docs/architecture/overview.md) —
// closes the one real durability hole in the notifications queue: a row left in
// `status='queued'` because its post-commit `notification.queued` emit was lost.
// Hourly, re-emit `notification.queued` for such rows (bounded window; see
// the pure handler). Idempotent — dispatch-notification's atomic queued→sending
// claim makes a re-emit a no-op when the row is already being dispatched.
//
// Runs on whichever backend is live: this Inngest cron today, and the mirrored
// pg-boss definition (lib/jobs/crons.ts) once JOBS_BACKEND flips. `emit` is the
// same best-effort emitNotificationQueued every producer uses.
export const redispatchQueuedCronFn = inngest.createFunction(
  {
    id: "redispatch-queued-cron",
    retries: 1,
    // Hourly, on the shared :00 wake grid — every cron minute off it opens its
    // own 5-minute Neon wake window (lib/env.ts isPreviewDeployment). Was */15
    // until D-115. This is a backstop for a lost emit, so a slower notice of a
    // stuck row costs nothing a user can perceive.
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) =>
    step.run("redispatch-stale-queued", () =>
      redispatchStaleQueuedNotifications({ prisma, emit: emitNotificationQueued }),
    ),
);
