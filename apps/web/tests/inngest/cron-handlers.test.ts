import { beforeEach, describe, expect, it, vi } from "vitest";

// Cron handlers with real orchestration logic (the thin one-line wrappers over
// already-tested lib are exercised by those lib suites). These drive the
// exported handlers with a fake step runner.

vi.mock("@/lib/inngest/client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

const state = {
  stale: [] as Array<{ id: string; teacherId: string; packageId: string }>,
  completeResults: {} as Record<string, { completed: boolean }>,
  anonymizeResult: { anonymized: 0, errors: [] as string[] },
};

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findMany: vi.fn(async () => state.stale) } },
}));

const maybeCompleteBooking = vi.fn(
  async ({ bookingId }: { bookingId: string }) =>
    state.completeResults[bookingId] ?? { completed: false },
);
vi.mock("@/lib/cancellation/auto-complete", () => ({ maybeCompleteBooking }));

const anonymizeMaturedDeletions = vi.fn(async () => state.anonymizeResult);
vi.mock("@/lib/account-deletion/anonymize", () => ({ anonymizeMaturedDeletions }));

// The deletion handler now reads hasStripeCreds() to decide whether to wire a
// Stripe subscription canceller. Stub it (false) so the handler doesn't touch
// serverEnv (unvalidated in this unit context) or the real Stripe client.
vi.mock("@/lib/env", () => ({ hasStripeCreds: () => false }));
vi.mock("@/lib/stripe", () => ({ getStripeClient: vi.fn() }));

const Sentry = await import("@sentry/nextjs");
const { autoCompleteSweepHandler } = await import("@/lib/inngest/functions/auto-complete-sweep");
const { accountDeletionHandler } = await import("@/lib/inngest/functions/account-deletion");

// Fake step runner that runs each step callback inline.
const step = { run: async <T>(_id: string, fn: () => T | Promise<T>) => fn() };

beforeEach(() => {
  vi.clearAllMocks();
  state.stale = [];
  state.completeResults = {};
  state.anonymizeResult = { anonymized: 0, errors: [] };
});

describe("autoCompleteSweepHandler", () => {
  it("reports zero when no stale bookings exist", async () => {
    expect(await autoCompleteSweepHandler({ step })).toEqual({
      found: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("tallies completed vs skipped across the batch", async () => {
    state.stale = [
      { id: "b1", teacherId: "t1", packageId: "p1" },
      { id: "b2", teacherId: "t1", packageId: "p1" },
      { id: "b3", teacherId: "t1", packageId: "p1" },
    ];
    state.completeResults = {
      b1: { completed: true },
      b2: { completed: false },
      b3: { completed: true },
    };
    const res = await autoCompleteSweepHandler({ step });
    expect(res).toEqual({ found: 3, completed: 2, skipped: 1, failed: 0 });
    expect(maybeCompleteBooking).toHaveBeenCalledTimes(3);
  });
});

describe("accountDeletionHandler", () => {
  it("runs the anonymizer and stays quiet on success", async () => {
    state.anonymizeResult = { anonymized: 2, errors: [] };
    const res = await accountDeletionHandler({ step });
    expect(res).toEqual({ anonymized: 2, errors: [] });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("reports anonymization errors to Sentry", async () => {
    state.anonymizeResult = { anonymized: 1, errors: ["boom"] };
    await accountDeletionHandler({ step });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "[account-deletion] anonymization errors",
      expect.objectContaining({ level: "warning" }),
    );
  });
});
