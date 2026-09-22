import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { enqueueInsightsReviewNudge } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { logger } from "@/lib/logger";

const log = logger({ surface: "lesson-insights-nudge" });

// Same client/transaction type the enqueue producers accept.
type NudgeDb = Parameters<typeof enqueueInsightsReviewNudge>[0];

// Enqueue the review nudge at most once per booking — a re-analysis must not
// re-ping. Returns the new notification id, or null when one already exists.
export async function queueReviewNudgeOnce(
  db: NudgeDb,
  input: { teacherId: string; bookingId: string; count: number },
): Promise<string | null> {
  const existing = await db.notification.findFirst({
    where: { bookingId: input.bookingId, templateName: "lesson_insights_review_teacher" },
    select: { id: true },
  });
  if (existing) return null;
  return enqueueInsightsReviewNudge(db, input);
}

// Lesson-insights post-class review nudge (Phase F,
// the Phase F design). The one Phase-F piece that
// consumes `lesson.insights.ready` (the brief is on-demand; this is event-driven):
// when Phase C produced focus areas for a class, nudge the teacher to run her
// ~10-second validation pass. Best-effort — teacher email-only (push when a
// device token exists), and deduped to one nudge per booking so a re-generation
// doesn't re-ping.
export const onLessonInsightsReadyFn = inngest.createFunction(
  {
    id: "on-lesson-insights-ready",
    retries: 3,
    triggers: [{ event: "lesson.insights.ready" }],
  },
  async ({ event, step }) => {
    const { bookingId, teacherId, count } = event.data as {
      bookingId: string;
      teacherId: string;
      count: number;
    };
    if (count <= 0) return { ok: true, skipped: "no-insights" };

    const notificationId = await step.run("enqueue-nudge", () =>
      queueReviewNudgeOnce(prisma, { teacherId, bookingId, count }),
    );

    if (!notificationId) return { ok: true, skipped: "already-nudged" };

    await emitNotificationQueued({ notificationId, teacherId });
    log.info("review nudge queued", { bookingId, count });
    return { ok: true, notificationId };
  },
);
