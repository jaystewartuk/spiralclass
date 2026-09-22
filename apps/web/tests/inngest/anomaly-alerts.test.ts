import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hourly anomaly scan. detectAnomalies is the pure detection core (the cron
// wrapper just emits each to Sentry). The threshold BEHAVIOUR and the
// per-teacher refund clustering are the security-relevant parts, so pin them:
// nothing fires one below the threshold, the right fingerprints + levels fire
// at it.
//
// Every case is driven from `anomalyThresholds()` rather than from literals.
// The live values are environment configuration and are deliberately not in
// this tree, so a test that restated them would either leak them or rot.

const counts = {
  refunded: 0,
  failedNotifications: 0,
  failedPayments: 0,
  pushFailures: 0,
};
const refundsByTeacher: Array<{ package: { teacherId: string } }> = [];
const overrides: Array<{ action: string; targetId: string; teacherId: string }> = [];

// The function module imports the Inngest client, which validates the server
// env at load. Stub the client so importing the module needs no real env.
vi.mock("@/lib/inngest/client", () => ({
  inngest: { createFunction: () => ({}) },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      count: vi.fn(async ({ where }: { where: { status: string } }) =>
        where.status === "refunded" ? counts.refunded : counts.failedPayments,
      ),
      findMany: vi.fn(async () => refundsByTeacher),
    },
    override: { findMany: vi.fn(async () => overrides) },
    notification: {
      // Two count() call sites: the status='failed' rate (#4) and the
      // metadata.pushError rate (#6, distinguished by the JSON `metadata` filter).
      count: vi.fn(async ({ where }: { where: { metadata?: unknown } }) =>
        where.metadata ? counts.pushFailures : counts.failedNotifications,
      ),
    },
  },
}));

const { detectAnomalies, anomalyThresholds } =
  await import("@/lib/inngest/functions/anomaly-alerts");

const T = anomalyThresholds();

const NOW = new Date("2026-06-12T12:00:00Z");

beforeEach(() => {
  counts.refunded = 0;
  counts.failedNotifications = 0;
  counts.failedPayments = 0;
  counts.pushFailures = 0;
  refundsByTeacher.length = 0;
  overrides.length = 0;
});

function fingerprints(list: Awaited<ReturnType<typeof detectAnomalies>>): string[] {
  return list.map((a) => a.fingerprint);
}

describe("detectAnomalies", () => {
  it("returns nothing on a quiet hour", async () => {
    expect(await detectAnomalies(NOW)).toEqual([]);
  });

  it("flags a platform-wide refund spike at the threshold", async () => {
    counts.refunded = T.refund;
    const fps = fingerprints(await detectAnomalies(NOW));
    expect(fps).toContain("anomaly:refund-spike-platform");
  });

  it("does not flag the platform refund spike one below the threshold", async () => {
    counts.refunded = T.refund - 1;
    expect(fingerprints(await detectAnomalies(NOW))).not.toContain("anomaly:refund-spike-platform");
  });

  it("raises an error-level per-teacher refund cluster at the threshold", async () => {
    counts.refunded = T.refundPerTeacher;
    for (let i = 0; i < T.refundPerTeacher; i++)
      refundsByTeacher.push({ package: { teacherId: "t1" } });
    const list = await detectAnomalies(NOW);
    const cluster = list.find((a) => a.fingerprint === "anomaly:refund-spike-teacher:t1");
    expect(cluster?.level).toBe("error");
    expect(cluster?.extras).toMatchObject({ teacherId: "t1", count: T.refundPerTeacher });
  });

  it("flags teacher and student disables independently, each at its own threshold", async () => {
    for (let i = 0; i < T.teacherDisable; i++)
      overrides.push({ action: "disable_teacher", targetId: `t${i}`, teacherId: `t${i}` });
    for (let i = 0; i < T.studentDisable - 1; i++)
      overrides.push({ action: "disable_student", targetId: `s${i}`, teacherId: "t1" });
    const fps = fingerprints(await detectAnomalies(NOW));
    expect(fps).toContain("anomaly:teacher-disabled");
    expect(fps).not.toContain("anomaly:student-disable-cluster");

    overrides.push({ action: "disable_student", targetId: "sN", teacherId: "t1" });
    expect(fingerprints(await detectAnomalies(NOW))).toContain("anomaly:student-disable-cluster");
  });

  it("flags elevated notification and payment failure rates", async () => {
    counts.failedNotifications = T.failedNotifications;
    counts.failedPayments = T.failedPayments;
    const fps = fingerprints(await detectAnomalies(NOW));
    expect(fps).toContain("anomaly:notification-failure-rate");
    expect(fps).toContain("anomaly:payment-failure-rate");
  });

  it("raises an error-level push-delivery failure alert at the threshold", async () => {
    // Regression guard for the 2026-07-07 FCM-credential outage: push failures
    // land on status='sent' rows, so this must be caught via metadata.pushError,
    // independently of the status='failed' rate.
    counts.pushFailures = T.pushFailures;
    const a = (await detectAnomalies(NOW)).find(
      (x) => x.fingerprint === "anomaly:push-delivery-failure-rate",
    );
    expect(a?.level).toBe("error");
    expect(a?.extras).toMatchObject({ count: T.pushFailures });
  });

  it("does not flag push-delivery failures one below the threshold", async () => {
    counts.pushFailures = T.pushFailures - 1;
    expect(fingerprints(await detectAnomalies(NOW))).not.toContain(
      "anomaly:push-delivery-failure-rate",
    );
  });
});

// The thresholds are environment configuration precisely so the live values are
// not in this tree. That makes the resolver itself security-relevant: a typo in
// a deployed variable must not silently raise the bar (or, worse, disable a
// detector) — it has to fall back to the in-code default and keep alerting.
describe("anomalyThresholds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("takes the deployed value over the in-code default", () => {
    vi.stubEnv("ANOMALY_REFUND_THRESHOLD", "3");
    expect(anomalyThresholds().refund).toBe(3);
  });

  it("falls back to the default when the variable is absent or blank", () => {
    const fallback = anomalyThresholds().teacherDisable;
    vi.stubEnv("ANOMALY_TEACHER_DISABLE_THRESHOLD", "   ");
    expect(anomalyThresholds().teacherDisable).toBe(fallback);
  });

  it.each([
    ["not-a-number", "a typo"],
    ["0", "zero, which would fire on every quiet hour"],
    ["-1", "a negative, same"],
  ])("falls back to the default on %s (%s)", (raw) => {
    const fallback = anomalyThresholds().refundPerTeacher;
    vi.stubEnv("ANOMALY_REFUND_PER_TEACHER_THRESHOLD", raw);
    expect(anomalyThresholds().refundPerTeacher).toBe(fallback);
  });

  it("resolves each detector independently", () => {
    vi.stubEnv("ANOMALY_PUSH_FAILURE_THRESHOLD", "42");
    const t = anomalyThresholds();
    expect(t.pushFailures).toBe(42);
    expect(t.refund).toBe(T.refund);
  });

  it("is read per call, so detection follows a retune without a rebuild", async () => {
    counts.refunded = 2;
    expect(fingerprints(await detectAnomalies(NOW))).not.toContain("anomaly:refund-spike-platform");
    vi.stubEnv("ANOMALY_REFUND_THRESHOLD", "2");
    expect(fingerprints(await detectAnomalies(NOW))).toContain("anomaly:refund-spike-platform");
  });
});
