import { describe, expect, it, vi } from "vitest";

// emitNotificationQueued is the single seam every producer path uses to fire
// the dispatcher. As of Phase 2a it routes through the provider-agnostic
// enqueue() seam (JOBS_BACKEND decides inngest vs pg-boss — that routing is
// covered by tests/jobs/enqueue.test.ts). Here we pin that it enqueues exactly
// the `notification.queued` event the dispatcher triggers on, and stays
// best-effort.

const enqueue = vi.fn(async () => {});
vi.mock("@/lib/jobs/enqueue", () => ({ enqueue }));

const { emitNotificationQueued } = await import("@/lib/notifications/events");

describe("emitNotificationQueued", () => {
  it("enqueues notification.queued with the notification + teacher ids", async () => {
    await emitNotificationQueued({ notificationId: "n1", teacherId: "t1" });
    expect(enqueue).toHaveBeenCalledWith("notification.queued", {
      notificationId: "n1",
      teacherId: "t1",
    });
  });

  it("is best-effort: an enqueue failure is swallowed, never thrown to the caller", async () => {
    // The notifications row is already committed before this runs, so a dispatch
    // failure (or absent creds, where the SDK throws "no event key") must not
    // fail the user-facing action that produced it (e.g. the Wise checkout would
    // otherwise 500).
    enqueue.mockRejectedValueOnce(new Error("no event key"));
    await expect(
      emitNotificationQueued({ notificationId: "n2", teacherId: "t2" }),
    ).resolves.toBeUndefined();
  });
});
