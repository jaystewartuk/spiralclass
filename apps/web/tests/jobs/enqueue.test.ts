import { beforeEach, describe, expect, it, vi } from "vitest";

// enqueue() is the provider-agnostic seam Phase 2 will flip producers onto
// (docs/architecture/overview.md). Today it isn't
// called by any producer — this pins its own routing behaviour so that
// future wiring is a call-site change only, never a seam-behaviour change.

// Typed with its payload so a test can inspect the exact object built for
// Inngest — the ts/id mapping below asserts on which KEYS are present.
const send = vi.fn(async (_payload: Record<string, unknown>) => {});
vi.mock("@/lib/inngest/client", () => ({ inngest: { send } }));

vi.mock("@/lib/env", () => ({ jobsBackend: vi.fn(() => "inngest") }));

const bossSend = vi.fn(async () => "job-id");
vi.mock("@/lib/jobs/boss", () => ({ getBoss: () => ({ send: bossSend }) }));

const { enqueue, enqueueNotification } = await import("@/lib/jobs/enqueue");
const { jobsBackend } = await import("@/lib/env");

beforeEach(() => {
  send.mockClear();
  bossSend.mockClear();
  vi.mocked(jobsBackend).mockReturnValue("inngest");
});

describe("enqueue", () => {
  it("routes to inngest.send while JOBS_BACKEND is (the default) inngest", async () => {
    await enqueue("notification.queued", { notificationId: "n1", teacherId: "t1" });
    expect(send).toHaveBeenCalledWith({
      name: "notification.queued",
      data: { notificationId: "n1", teacherId: "t1" },
    });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("routes to pg-boss's send when JOBS_BACKEND=pgboss, forwarding options", async () => {
    vi.mocked(jobsBackend).mockReturnValue("pgboss");
    await enqueue(
      "notification.queued",
      { notificationId: "n2", teacherId: "t2" },
      { singletonKey: "n2" },
    );
    expect(bossSend).toHaveBeenCalledWith(
      "notification.queued",
      { notificationId: "n2", teacherId: "t2" },
      { singletonKey: "n2" },
    );
    expect(send).not.toHaveBeenCalled();
  });
});

// D-115: the seam's two options are no longer pg-boss-only. The reminder wake
// chain needs delayed, deduped delivery on WHICHEVER backend is live, and the
// Inngest event payload has both primitives — `ts` (an event dated in the
// future is held until then) and `id` (idempotency key, 24h window). Mapping
// them here is what lets one call site in reminder-scan.ts serve both backends.
describe("enqueue — delay and dedup on the Inngest path", () => {
  it("maps an absolute startAfter onto the event's ts, and singletonKey onto id", async () => {
    const at = new Date("2026-07-10T12:34:56.000Z");
    await enqueue(
      "reminder.due",
      { scheduledFor: at.toISOString() },
      { startAfter: at, singletonKey: `reminder-wake-${at.toISOString()}` },
    );
    expect(send).toHaveBeenCalledWith({
      name: "reminder.due",
      data: { scheduledFor: at.toISOString() },
      ts: at.getTime(),
      id: "reminder-wake-2026-07-10T12:34:56.000Z",
    });
  });

  it("reads a numeric startAfter as seconds-from-now (pg-boss's own convention)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    await enqueue("reminder.due", { scheduledFor: "x" }, { startAfter: 90 });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ ts: new Date("2026-07-10T12:01:30.000Z").getTime() }),
    );
    vi.useRealTimers();
  });

  it("omits ts and id entirely when neither option is given", async () => {
    // An undated event must stay undated — an accidental `ts: undefined` on the
    // payload is not the same thing to every transport, and "now" is the
    // default we want for every producer that isn't scheduling.
    await enqueue("notification.queued", { notificationId: "n4", teacherId: "t4" });
    const payload = send.mock.calls[0]![0];
    expect(Object.keys(payload).sort()).toEqual(["data", "name"]);
  });

  it("forwards both options untouched to pg-boss, which understands them natively", async () => {
    vi.mocked(jobsBackend).mockReturnValue("pgboss");
    const at = new Date("2026-07-10T12:34:56.000Z");
    await enqueue(
      "reminder.due",
      { scheduledFor: at.toISOString() },
      { startAfter: at, singletonKey: "reminder-wake-x" },
    );
    expect(bossSend).toHaveBeenCalledWith(
      "reminder.due",
      { scheduledFor: at.toISOString() },
      { startAfter: at, singletonKey: "reminder-wake-x" },
    );
  });
});

describe("enqueueNotification", () => {
  it("enqueues notification.queued with the given ids", async () => {
    await enqueueNotification("n3", "t3");
    expect(send).toHaveBeenCalledWith({
      name: "notification.queued",
      data: { notificationId: "n3", teacherId: "t3" },
    });
  });
});
