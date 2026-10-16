import { beforeEach, describe, expect, it, vi } from "vitest";

// The AI acceptance figures on the admin overview (D-201): confirmed-over-
// decided for lesson insights, used-over-decided for homework drafts. Counts
// only (D-23), test accounts out (D-192).

const insightCount = vi.fn(async (..._: unknown[]) => 0);
const draftCount = vi.fn(async (..._: unknown[]) => 0);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lessonInsight: { count: (...a: unknown[]) => insightCount(...a) },
    homeworkAiReviewDraft: { count: (...a: unknown[]) => draftCount(...a) },
  },
}));

const { summarizeVerdicts, getAiQualityMetrics } = await import("@/lib/ai/quality-metrics");

describe("summarizeVerdicts", () => {
  it("rates accepted over decided, leaving pending rows out of the denominator", () => {
    expect(summarizeVerdicts({ accepted: 3, rejected: 1, pending: 40 })).toEqual({
      accepted: 3,
      rejected: 1,
      pending: 40,
      acceptanceRate: 0.75,
    });
  });

  it("reports an unknown rate, not 0%, when nothing has been judged", () => {
    expect(summarizeVerdicts({ accepted: 0, rejected: 0, pending: 12 }).acceptanceRate).toBeNull();
  });

  it("is 0% when every judged row was thrown out", () => {
    expect(summarizeVerdicts({ accepted: 0, rejected: 5, pending: 0 }).acceptanceRate).toBe(0);
  });
});

describe("getAiQualityMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insightCount.mockResolvedValueOnce(6).mockResolvedValueOnce(2).mockResolvedValueOnce(9);
    draftCount.mockResolvedValueOnce(1).mockResolvedValueOnce(3).mockResolvedValueOnce(0);
  });

  it("partitions AI insights into confirmed, dismissed and unreviewed", async () => {
    const metrics = await getAiQualityMetrics();
    expect(metrics.insights).toEqual({
      accepted: 6,
      rejected: 2,
      pending: 9,
      acceptanceRate: 0.75,
    });
    const wheres = insightCount.mock.calls.map((c) => (c[0] as { where: unknown }).where);
    expect(wheres).toEqual([
      expect.objectContaining({ source: "ai", confirmedAt: { not: null } }),
      expect.objectContaining({ source: "ai", confirmedAt: null, dismissedAt: { not: null } }),
      expect.objectContaining({ source: "ai", confirmedAt: null, dismissedAt: null }),
    ]);
  });

  it("partitions homework drafts into used, regenerated-past and unresolved", async () => {
    const metrics = await getAiQualityMetrics();
    expect(metrics.homeworkDrafts).toEqual({
      accepted: 1,
      rejected: 3,
      pending: 0,
      acceptanceRate: 0.25,
    });
    const wheres = draftCount.mock.calls.map((c) => (c[0] as { where: unknown }).where);
    expect(wheres).toEqual([
      expect.objectContaining({ resultingFeedback: { some: {} } }),
      expect.objectContaining({ resultingFeedback: { none: {} }, discardedAt: { not: null } }),
      expect.objectContaining({ resultingFeedback: { none: {} }, discardedAt: null }),
    ]);
  });

  it("leaves test teachers and test students out of every count (D-192)", async () => {
    await getAiQualityMetrics();
    const realBooking = { teacher: { testAccount: false }, student: { testAccount: false } };
    for (const call of insightCount.mock.calls) {
      expect((call[0] as { where: { booking: unknown } }).where.booking).toEqual(realBooking);
    }
    for (const call of draftCount.mock.calls) {
      expect(
        (call[0] as { where: { attempt: { submission: { assignment: { booking: unknown } } } } })
          .where.attempt.submission.assignment.booking,
      ).toEqual(realBooking);
    }
  });
});
