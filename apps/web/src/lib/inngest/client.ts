import { Inngest } from "inngest";
import { hasInngestCreds, serverEnv } from "@/lib/env";
import { INNGEST_APP_ID } from "./app-id";

// Single app-wide Inngest client. When creds are missing (dev / tests),
// events still go through this instance — Inngest's SDK runs in a local
// mode and will connect to `npx inngest-cli dev` on localhost:8288 if
// present, or discard events otherwise. Production requires both keys
// via hasInngestCreds().
//
// Event schemas are defined inline here so function handlers stay typed.

export type Events = {
  "notification.queued": { data: { notificationId: string; teacherId: string } };
  "booking.created": {
    data: {
      bookingId: string;
      teacherId: string;
      studentId: string;
      packageId: string;
      scheduledStart: string; // ISO
    };
  };
  "booking.canceled": {
    data: { bookingId: string; teacherId: string };
  };
  "booking.rescheduled": {
    data: { bookingId: string; teacherId: string; newScheduledStart: string };
  };
  "payment.paid": {
    data: { paymentId: string; packageId: string; teacherId: string; studentId: string };
  };
  // A single delayed "re-run the reminder scan at this moment" wake, armed by
  // lib/notifications/reminder-scan.ts's scanAndScheduleNextWake so the hourly
  // cron can still serve the 15m leg exactly (see that file's header for the
  // Neon compute arithmetic, and D-115). Deliberately carries no booking
  // identity: the handler re-derives every decision from the live booking rows,
  // so a cancelled or rescheduled class cannot mis-fire off a stale wake.
  // `scheduledFor` is the moment the wake was armed for, for diagnostics and as
  // the idempotency key's source.
  "reminder.due": {
    data: { scheduledFor: string };
  };
  // Lesson insights Phase A: a
  // per-participant audio capture has landed in R2 and is ready for analysis.
  // Phase A only logs it; Phase B replaces the handler body with the ASR call.
  "lesson.audio.ready": {
    data: {
      bookingId: string;
      audioId: string;
      speaker: "student" | "teacher";
      storageKey: string;
    };
  };
  // Lesson insights Phase B: a
  // booking's per-speaker audio is fully transcribed and merged into one
  // LessonTranscript. Phase C (analysis) consumes this.
  "lesson.transcript.ready": {
    data: { bookingId: string };
  };
  // Intro-video coach Layer 2 (D-73): a teacher recorded/uploaded their public
  // intro video. The handler transcribes it (Pro-gated, flag-gated) into the
  // teacher's IntroVideoAnalysis row. `videoPath` pins the object the event was
  // queued for so a re-record/removal makes a stale run a no-op.
  "intro-video.ready": {
    data: { teacherId: string; videoPath: string };
  };
  // Lesson insights Phase C: the
  // AI focus areas for a booking have been (re)generated. Phase F notifications
  // consume this.
  "lesson.insights.ready": {
    data: { bookingId: string; teacherId: string; count: number };
  };
  // A teacher requested a podcast for one of her materials. The slow pipeline
  // (Claude writes the spoken script → ElevenLabs renders the mp3 → R2 upload →
  // mark the MaterialPodcast row ready) runs in on-material-podcast-requested.ts,
  // off the request path. locale drives the script's narration-language default.
  "material.podcast.requested": {
    data: {
      teacherId: string;
      materialId: string;
      language?: string | null;
      targetDurationMin?: number | null;
      locale: "en" | "es";
    };
  };
  // /admin/uat's Reseed button (D-55) — reseeding is slow/bulk, so it runs
  // as a background job rather than blocking the admin request. Preview-only;
  // see lib/uat/env-targets.ts's assertReseedAllowed() and seed.ts's own
  // assertNotProductionTarget() for the guards.
  "admin/uat.reseed-preview": {
    data: {
      requestedByAdminId: string;
      // Same knobs as `SEED_BULK_TEACHERS`/`SEED_BULK_STUDENTS_PER_TEACHER` on
      // the CLI (scripts/seed.ts's main()) — omitted means the seed's own
      // defaults (0 bulk teachers, 6 students each).
      bulkTeachers?: number;
      studentsPerBulkTeacher?: number;
    };
  };
};

export const inngest = new Inngest({
  id: INNGEST_APP_ID,
  eventKey: serverEnv().INNGEST_EVENT_KEY,
  // Omitting signingKey here; it's read by inngest/next serve() handler
  // from the env directly.
});

export function getInngestKind(): "real" | "stub" {
  return hasInngestCreds() ? "real" : "stub";
}
