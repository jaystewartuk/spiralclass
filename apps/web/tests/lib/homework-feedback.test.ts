import { beforeEach, describe, expect, it, vi } from "vitest";

// feedback.ts is a server module (`import "server-only"`); neutralize the
// guard, same as homework-wire.test.ts. Covers the shared business logic
// behind BOTH the mobile teacher route and the web review action
// (docs/features/homework.md): ownership resolution,
// reject-a-second-review, the decision -> submission-status mapping, the
// "only the latest attempt flips current status" guard, and the best-effort
// student notification.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/storage/homework-file", () => ({
  mintSubmissionSignedUrl: vi.fn(async () => "https://cdn.test/hw.pdf"),
}));

const TEACHER = { id: "t1" };

const ATTEMPT = {
  id: "at1",
  attemptNumber: 1,
  submission: {
    id: "sub1",
    assignmentId: "a1",
    studentId: "s1",
    teacherId: "t1",
    assignment: { bookingId: "b1", title: "Essay" },
  },
};

const resolveTeacherAttempt = vi.fn(async (..._: unknown[]) => ATTEMPT as unknown);
vi.mock("@/lib/homework/access", () => ({
  resolveTeacherAttempt: (...a: unknown[]) => resolveTeacherAttempt(...a),
}));

const enqueueHomeworkFeedbackAvailable = vi.fn(async (..._: unknown[]) => "notif-1");
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueHomeworkFeedbackAvailable: (...a: unknown[]) => enqueueHomeworkFeedbackAvailable(...a),
}));
const emitNotificationQueued = vi.fn(async (..._: unknown[]) => {});
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: (...a: unknown[]) => emitNotificationQueued(...a),
}));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: (...a: unknown[]) => trackServerEvent(...a),
}));

const feedbackFindUnique = vi.fn(async (..._: unknown[]) => null as unknown);
const feedbackCreate = vi.fn(
  async (..._: unknown[]) =>
    ({
      id: "f1",
      decision: "approved",
      content: "Nice work",
      score: 8,
      createdAt: new Date("2026-07-10T00:00:00Z"),
    }) as unknown,
);
const attemptCount = vi.fn(async (..._: unknown[]) => 1);
const submissionUpdate = vi.fn(async (..._: unknown[]) => ({}) as unknown);

const prismaMock = {
  homeworkFeedback: {
    findUnique: (...a: unknown[]) => feedbackFindUnique(...a),
    create: (...a: unknown[]) => feedbackCreate(...a),
  },
  homeworkAttempt: { count: (...a: unknown[]) => attemptCount(...a) },
  homeworkSubmission: { update: (...a: unknown[]) => submissionUpdate(...a) },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock),
};
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const { createHomeworkFeedback } = await import("@/lib/homework/feedback");

beforeEach(() => {
  vi.clearAllMocks();
  feedbackFindUnique.mockResolvedValue(null);
  attemptCount.mockResolvedValue(1); // attempt #1 is the only/latest one
  feedbackCreate.mockResolvedValue({
    id: "f1",
    decision: "approved",
    content: "Nice work",
    score: 8,
    createdAt: new Date("2026-07-10T00:00:00Z"),
  });
});

describe("createHomeworkFeedback", () => {
  it("rejects a second review of an already-reviewed attempt", async () => {
    feedbackFindUnique.mockResolvedValue({ id: "existing" });
    await expect(
      createHomeworkFeedback(
        TEACHER as never,
        "at1",
        { decision: "approved", content: "hi" },
        "web",
      ),
    ).rejects.toMatchObject({ status: 409, reason: "already-reviewed" });
    expect(feedbackCreate).not.toHaveBeenCalled();
  });

  it("creates feedback and flips the submission to graded on approval (latest attempt)", async () => {
    await createHomeworkFeedback(
      TEACHER as never,
      "at1",
      { decision: "approved", content: "Nice work", score: 8 },
      "web",
    );
    expect(feedbackCreate).toHaveBeenCalledWith({
      data: {
        attemptId: "at1",
        teacherId: "t1",
        decision: "approved",
        content: "Nice work",
        score: 8,
      },
    });
    expect(submissionUpdate).toHaveBeenCalledWith({
      where: { id: "sub1" },
      data: { status: "graded" },
    });
  });

  it("re-opens the submission (returned) for resubmission_requested and rejected", async () => {
    await createHomeworkFeedback(
      TEACHER as never,
      "at1",
      { decision: "resubmission_requested", content: "Fix this" },
      "web",
    );
    expect(submissionUpdate).toHaveBeenCalledWith({
      where: { id: "sub1" },
      data: { status: "returned" },
    });

    submissionUpdate.mockClear();
    await createHomeworkFeedback(
      TEACHER as never,
      "at1",
      { decision: "rejected", content: "Not acceptable" },
      "web",
    );
    expect(submissionUpdate).toHaveBeenCalledWith({
      where: { id: "sub1" },
      data: { status: "returned" },
    });
  });

  it("does NOT flip the submission's status when this isn't the latest attempt", async () => {
    attemptCount.mockResolvedValue(2); // a newer attempt exists
    await createHomeworkFeedback(
      TEACHER as never,
      "at1",
      { decision: "approved", content: "Late review of an old attempt" },
      "web",
    );
    expect(feedbackCreate).toHaveBeenCalledOnce();
    expect(submissionUpdate).not.toHaveBeenCalled();
  });

  it("notifies the student with the decision and enqueues via the shared events emitter", async () => {
    await createHomeworkFeedback(
      TEACHER as never,
      "at1",
      { decision: "approved", content: "Nice work" },
      "mobile",
    );
    expect(enqueueHomeworkFeedbackAvailable).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        studentId: "s1",
        teacherId: "t1",
        bookingId: "b1",
        assignmentTitle: "Essay",
        decision: "approved",
      }),
    );
    expect(emitNotificationQueued).toHaveBeenCalledWith({
      notificationId: "notif-1",
      teacherId: "t1",
    });
  });

  it("never throws when the notification enqueue fails", async () => {
    enqueueHomeworkFeedbackAvailable.mockRejectedValueOnce(new Error("db down"));
    await expect(
      createHomeworkFeedback(
        TEACHER as never,
        "at1",
        { decision: "approved", content: "ok" },
        "web",
      ),
    ).resolves.toMatchObject({ id: "f1" });
  });

  it("tracks creation with the given surface and hasScore flag", async () => {
    await createHomeworkFeedback(
      TEACHER as never,
      "at1",
      { decision: "approved", content: "ok", score: null },
      "mobile",
    );
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "homework_feedback_created",
        properties: expect.objectContaining({
          teacherId: "t1",
          assignmentId: "a1",
          attemptId: "at1",
          decision: "approved",
          hasScore: false,
          surface: "mobile",
        }),
      }),
    );
  });
});
