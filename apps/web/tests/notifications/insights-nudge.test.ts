import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the Inngest client so importing the fn module doesn't pull serverEnv.
vi.mock("@/lib/inngest/client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn() }));

import { enqueueInsightsReviewNudge } from "@/lib/notifications/enqueue";
import { queueReviewNudgeOnce } from "@/lib/inngest/functions/on-lesson-insights-ready";
import { renderPush } from "@/lib/notifications/push";
import { renderEmail } from "@/lib/email/templates";

const VARS = {
  teacherName: "Mira",
  studentName: "Beto",
  count: 3,
  dashboardPathSuffix: "dashboard/clases/b1",
};

describe("enqueueInsightsReviewNudge", () => {
  it("writes a teacher-recipient, email-channel row with count metadata", async () => {
    const created: any[] = [];
    const tx = {
      notification: {
        create: vi.fn(async ({ data }: any) => {
          created.push(data);
          return { id: "n1" };
        }),
      },
    };
    const id = await enqueueInsightsReviewNudge(tx as never, {
      teacherId: "t1",
      bookingId: "b1",
      count: 3,
    });
    expect(id).toBe("n1");
    expect(created[0]).toMatchObject({
      teacherId: "t1",
      recipientType: "teacher",
      recipientId: "t1",
      bookingId: "b1",
      channel: "email",
      templateName: "lesson_insights_review_teacher",
      status: "queued",
      metadata: { count: 3 },
    });
  });
});

describe("queueReviewNudgeOnce", () => {
  function db(existing: boolean) {
    return {
      notification: {
        findFirst: vi.fn(async () => (existing ? { id: "prev" } : null)),
        create: vi.fn(async () => ({ id: "new" })),
      },
    };
  }

  it("enqueues when no prior nudge exists for the booking", async () => {
    const d = db(false);
    const id = await queueReviewNudgeOnce(d as never, {
      teacherId: "t1",
      bookingId: "b1",
      count: 2,
    });
    expect(id).toBe("new");
    expect(d.notification.create).toHaveBeenCalledTimes(1);
  });

  it("skips (dedup) when a nudge already exists for the booking", async () => {
    const d = db(true);
    const id = await queueReviewNudgeOnce(d as never, {
      teacherId: "t1",
      bookingId: "b1",
      count: 2,
    });
    expect(id).toBeNull();
    expect(d.notification.create).not.toHaveBeenCalled();
  });
});

describe("review nudge rendering", () => {
  it("renders push copy (en + es) deep-linking to the booking", () => {
    const en = renderPush("lesson_insights_review_teacher", "en", VARS);
    expect(en.title).toMatch(/Focus areas/i);
    expect(en.body).toContain("Beto");
    expect(en.deepLink).toBe("dashboard/clases/b1");
    const es = renderPush("lesson_insights_review_teacher", "es_MX", VARS);
    expect(es.body).toContain("Beto");
  });

  it("renders an email (en + es) with a review CTA", () => {
    const en = renderEmail({
      templateName: "lesson_insights_review_teacher",
      languageCode: "en",
      variables: VARS,
      actionUrl: "https://app.example/dashboard/classes/b1",
    });
    expect(en.subject).toMatch(/Focus areas ready/i);
    expect(en.html).toContain("https://app.example/dashboard/classes/b1");
    expect(en.body).toContain("Beto");
    const es = renderEmail({
      templateName: "lesson_insights_review_teacher",
      languageCode: "es_MX",
      variables: VARS,
      actionUrl: "https://app.example/dashboard/classes/b1",
    });
    expect(es.subject).toMatch(/Áreas de enfoque/i);
  });
});
