import { enqueue } from "@/lib/jobs/enqueue";
import { logger } from "@/lib/logger";

const log = logger({ surface: "notification-events" });

// Emit the `notification.queued` Inngest event. Every producer that writes
// a notifications row calls this (after the wrapping transaction commits)
// so the dispatcher fires consistently across paths.
//
// BEST-EFFORT: the notifications row is already committed before this runs, so
// a transient dispatch failure (or absent Inngest creds in dev/E2E, where the
// SDK throws "no event key") must never bubble up and fail the user-facing
// action that produced it — the row survives and the cron dispatcher / a
// re-emit covers it. The booking/cancel paths already wrap their emit; doing it
// here protects every caller (web checkout, the mobile public-checkout route,
// every notification producer) in one place.
export async function emitNotificationQueued(input: {
  notificationId: string;
  teacherId: string;
}): Promise<void> {
  try {
    // Routed through the provider-agnostic seam (Phase 2a): JOBS_BACKEND
    // decides inngest.send vs pg-boss. Behaviour is identical while the flag
    // is (the default) "inngest". Still best-effort — see the note above.
    await enqueue("notification.queued", {
      notificationId: input.notificationId,
      teacherId: input.teacherId,
    });
  } catch (err) {
    log.error("event emission failed", err, {
      notificationId: input.notificationId,
      teacherId: input.teacherId,
    });
  }
}
