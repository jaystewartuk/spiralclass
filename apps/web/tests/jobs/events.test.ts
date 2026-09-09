import { describe, expect, it, vi, beforeEach } from "vitest";

// Phase 2a pg-boss event definitions (docs/architecture/overview.md
// the student portal). These run only when JOBS_BACKEND=pgboss. The load-bearing bit is the
// notification.queued handler's chat push→email cascade, modeled as a delayed
// pg-boss follow-up job instead of the Inngest handler's in-run step.sleep.

const dispatchNotification = vi.fn();
const sendChatEmailFallbackIfUnread = vi.fn(async () => ({}));
const bossSend = vi.fn(async () => "job-id");
const onMaterialPodcastRequestedHandler = vi.fn(async () => ({}));
const adminReseedPreviewHandler = vi.fn(async () => ({}));
const grantReferralRewardHandler = vi.fn(async () => ({}));
const magicLinkOnFirstPaymentHandler = vi.fn(async () => ({}));
const autoBookIntendedSlot = vi.fn(async () => ({}));

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification,
  sendChatEmailFallbackIfUnread,
}));
vi.mock("@/lib/inngest/functions/dispatch-notification", () => ({ makeDeps: () => ({}) }));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: () => ({ send: bossSend }) }));
vi.mock("@/lib/inngest/functions/on-material-podcast-requested", () => ({
  onMaterialPodcastRequestedHandler,
}));
vi.mock("@/lib/inngest/functions/admin-reseed-preview", () => ({ adminReseedPreviewHandler }));
vi.mock("@/lib/inngest/functions/grant-referral-reward", () => ({ grantReferralRewardHandler }));
vi.mock("@/lib/inngest/functions/magic-link-on-first-payment", () => ({
  magicLinkOnFirstPaymentHandler,
}));
vi.mock("@/lib/booking/auto-book-intended", () => ({ autoBookIntendedSlot }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/stripe", () => ({ getStripeClient: () => ({}) }));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn() }));
const scanAndScheduleNextWake = vi.fn(async (_deps: { enqueue: unknown }) => ({}));
vi.mock("@/lib/notifications/reminder-scan", () => ({ scanAndScheduleNextWake }));
vi.mock("@/lib/inngest/client", () => ({
  inngest: { send: vi.fn(), createFunction: () => ({}) },
}));

const { eventJobs } = await import("@/lib/jobs/events");

const jobOf = (queue: string) => eventJobs.find((d) => d.queue === queue)!;
// pg-boss delivers a batch array; each handler loops over it.
const deliver = (queue: string, data: unknown) => jobOf(queue).handler([{ data }] as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("jobs/events — Phase 2a event definitions", () => {
  it("registers the live event queues, none as crons", () => {
    expect(eventJobs.map((d) => d.queue).sort()).toEqual(
      [
        "admin/uat.reseed-preview",
        "material.podcast.requested",
        "notification.chat-email-fallback",
        "notification.queued",
        "payment.paid",
        "payment.paid.auto-book",
        "payment.paid.magic-link",
        "payment.paid.referral",
        // D-115: the reminder wake chain's delayed-job queue.
        "reminder.due",
      ].sort(),
    );
    for (const d of eventJobs) expect(d.cron).toBeUndefined();
  });

  it("payment.paid fans out to three child jobs with per-consumer retry budgets", async () => {
    const data = { paymentId: "p1", packageId: "pkg1", teacherId: "t1", studentId: "s1" };
    await deliver("payment.paid", data);

    // auto-book:3, referral:2, magic-link:2 — copied from each Inngest
    // function's `retries`. There is no payout child: under direct charges
    // (D-143) the money settles on the teacher's own connected account, so the
    // platform has nothing to move.
    expect(bossSend).toHaveBeenCalledWith("payment.paid.auto-book", data, {
      retryLimit: 3,
      retryBackoff: true,
    });
    expect(bossSend).toHaveBeenCalledWith("payment.paid.referral", data, {
      retryLimit: 2,
      retryBackoff: true,
    });
    expect(bossSend).toHaveBeenCalledWith("payment.paid.magic-link", data, {
      retryLimit: 2,
      retryBackoff: true,
    });
    expect(bossSend).toHaveBeenCalledTimes(3);
  });

  it("each payment.paid child runs its underlying consumer", async () => {
    const data = { paymentId: "p1", packageId: "pkg1", teacherId: "t1", studentId: "s1" };
    await deliver("payment.paid.auto-book", data);
    expect(autoBookIntendedSlot).toHaveBeenCalledWith(expect.anything(), "pkg1");

    await deliver("payment.paid.referral", data);
    expect(grantReferralRewardHandler).toHaveBeenCalledTimes(1);

    await deliver("payment.paid.magic-link", data);
    expect(magicLinkOnFirstPaymentHandler).toHaveBeenCalledTimes(1);
  });

  it("notification.queued dispatches, then schedules a delayed chat email fallback for a chat push", async () => {
    dispatchNotification.mockResolvedValue({
      code: "sent",
      channel: "push",
      providerMessageId: "p1",
      templateName: "chat_message",
    });

    await deliver("notification.queued", { notificationId: "n1", teacherId: "t1" });

    expect(dispatchNotification).toHaveBeenCalledWith("n1", expect.anything());
    expect(bossSend).toHaveBeenCalledWith(
      "notification.chat-email-fallback",
      { notificationId: "n1" },
      { startAfter: 180 },
    );
  });

  it("notification.queued does NOT schedule a fallback for a non-chat send", async () => {
    dispatchNotification.mockResolvedValue({
      code: "sent",
      channel: "push",
      providerMessageId: "p1",
      templateName: "reminder_24h",
    });

    await deliver("notification.queued", { notificationId: "n2", teacherId: "t1" });

    expect(dispatchNotification).toHaveBeenCalledWith("n2", expect.anything());
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("notification.queued does NOT schedule a fallback when the push was not sent (e.g. email)", async () => {
    dispatchNotification.mockResolvedValue({
      code: "sent",
      channel: "email",
      providerMessageId: "e1",
      templateName: "chat_message",
    });

    await deliver("notification.queued", { notificationId: "n3", teacherId: "t1" });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("the chat-email-fallback queue runs sendChatEmailFallbackIfUnread", async () => {
    await deliver("notification.chat-email-fallback", { notificationId: "n1" });
    expect(sendChatEmailFallbackIfUnread).toHaveBeenCalledWith("n1", expect.anything());
  });

  it("routes podcast + reseed jobs to their extracted handlers", async () => {
    await deliver("material.podcast.requested", { teacherId: "t1", materialId: "m1" });
    expect(onMaterialPodcastRequestedHandler).toHaveBeenCalledTimes(1);

    await deliver("admin/uat.reseed-preview", { requestedByAdminId: "a1" });
    expect(adminReseedPreviewHandler).toHaveBeenCalledTimes(1);
  });
  // D-115: the reminder wake chain's delivery end. reminder-scan-cron arms a
  // delayed job on this queue at the exact moment the next reminder leg comes
  // due, which is how an hourly cron still serves the 15m leg on time. The
  // handler re-runs the whole scan — the job carries no booking identity, so a
  // class cancelled or moved in the interim simply isn't due when it lands.
  it("re-runs the reminder scan when a reminder.due wake is delivered", async () => {
    await deliver("reminder.due", { scheduledFor: "2026-07-10T12:15:00.000Z" });
    expect(scanAndScheduleNextWake).toHaveBeenCalledTimes(1);
    // The scan arms the NEXT wake itself, so the chain continues from here.
    expect(scanAndScheduleNextWake.mock.calls[0]![0]).toHaveProperty("enqueue");
  });
});
