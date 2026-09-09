import { describe, expect, it } from "vitest";
import {
  addTotals,
  confidenceLabel,
  conversionRate,
  deriveObservations,
  EMPTY_FUNNEL,
  enquiryRate,
  funnelSteps,
  MIN_EFFECT_RATIO,
  MIN_STUDENTS_FOR_CLAIM,
  MIN_VISITS_FOR_COMPARISON,
  observationText,
  type PerformanceRow,
} from "./insights";

// The point of these tests is what the module REFUSES to say. A teacher acting
// on "Facebook is your best channel" derived from three visits has been given a
// coin flip dressed as advice.

function row(key: string, over: Partial<PerformanceRow> = {}): PerformanceRow {
  return {
    key,
    label: key,
    visits: 0,
    enquiries: 0,
    bookings: 0,
    students: 0,
    revenueMinorUnits: 0,
    ...over,
  };
}

describe("rates", () => {
  it("returns null rather than zero when there is no denominator", () => {
    expect(conversionRate(EMPTY_FUNNEL)).toBeNull();
    expect(enquiryRate(EMPTY_FUNNEL)).toBeNull();
  });
  it("computes plain fractions", () => {
    expect(conversionRate({ ...EMPTY_FUNNEL, visits: 100, students: 3 })).toBeCloseTo(0.03);
    expect(enquiryRate({ ...EMPTY_FUNNEL, visits: 50, enquiries: 5 })).toBeCloseTo(0.1);
  });
  it("adds totals field by field", () => {
    expect(
      addTotals({ ...EMPTY_FUNNEL, visits: 2, revenueMinorUnits: 100 }, { visits: 3, students: 1 }),
    ).toMatchObject({ visits: 5, students: 1, revenueMinorUnits: 100 });
  });
});

describe("deriveObservations — refusal to over-claim", () => {
  it("says nothing at all before any traffic exists", () => {
    const out = deriveObservations({ channels: [], communities: [], untriedCommunityLabels: [] });
    expect(out).toEqual([{ code: "no_data", confidence: "observed" }]);
  });

  it("will not name a best channel on one student", () => {
    const out = deriveObservations({
      channels: [row("facebook", { visits: 30, students: MIN_STUDENTS_FOR_CLAIM - 1 })],
      communities: [],
      untriedCommunityLabels: [],
    });
    expect(out.some((o) => o.code === "top_channel")).toBe(false);
  });

  it("names a best channel once the claim floor is cleared", () => {
    const out = deriveObservations({
      channels: [row("facebook", { visits: 40, students: MIN_STUDENTS_FOR_CLAIM })],
      communities: [],
      untriedCommunityLabels: [],
    });
    expect(out[0]).toMatchObject({ code: "top_channel", confidence: "pattern" });
  });

  it("will not compare two channels below the sample-size floor", () => {
    const out = deriveObservations({
      channels: [
        row("facebook", { visits: MIN_VISITS_FOR_COMPARISON - 1, students: 3 }),
        row("reddit", { visits: MIN_VISITS_FOR_COMPARISON - 1, students: 0 }),
      ],
      communities: [],
      untriedCommunityLabels: [],
    });
    expect(out.some((o) => o.code === "channel_outperforms")).toBe(false);
  });

  it("will not compare two channels whose difference is inside the noise floor", () => {
    const out = deriveObservations({
      channels: [
        row("facebook", { visits: 100, students: 10 }),
        // 10% vs 9% — well under MIN_EFFECT_RATIO.
        row("reddit", { visits: 100, students: 9 }),
      ],
      communities: [],
      untriedCommunityLabels: [],
    });
    expect(out.some((o) => o.code === "channel_outperforms")).toBe(false);
  });

  it("states a head-to-head once both floors are cleared", () => {
    const out = deriveObservations({
      channels: [
        row("facebook", { visits: 100, students: 10 }),
        row("reddit", { visits: 100, students: 2 }),
      ],
      communities: [],
      untriedCommunityLabels: [],
    });
    const found = out.find((o) => o.code === "channel_outperforms");
    expect(found).toMatchObject({ winner: "facebook", loser: "reddit", confidence: "pattern" });
    if (found && found.code === "channel_outperforms") {
      expect(found.ratio).toBeGreaterThanOrEqual(MIN_EFFECT_RATIO);
    }
  });

  it("flags real traffic that never enquires — the most actionable negative", () => {
    const out = deriveObservations({
      channels: [row("reddit", { visits: 60 })],
      communities: [],
      untriedCommunityLabels: [],
    });
    expect(out.some((o) => o.code === "traffic_no_enquiries")).toBe(true);
  });

  it("falls back to 'needs more data' rather than to silence", () => {
    const out = deriveObservations({
      channels: [row("direct", { visits: 4 })],
      communities: [],
      untriedCommunityLabels: [],
    });
    expect(out[0]).toMatchObject({ code: "needs_more_data", visits: 4 });
  });

  it("recognises referrals as their own channel when they outperform", () => {
    const out = deriveObservations({
      channels: [
        row("referral", { visits: 40, students: 8 }),
        row("facebook", { visits: 200, students: 4 }),
      ],
      communities: [],
      untriedCommunityLabels: [],
    });
    expect(out.some((o) => o.code === "referrals_convert_best")).toBe(true);
  });

  it("only ever appends suggestions after the observed facts", () => {
    const out = deriveObservations({
      channels: [row("facebook", { visits: 100, students: 4 })],
      communities: [row("g1", { label: "Oaxaca Expats", visits: 80, students: 4 })],
      untriedCommunityLabels: ["r/Spanish"],
    });
    const firstSuggestion = out.findIndex((o) => o.confidence === "suggestion");
    expect(firstSuggestion).toBeGreaterThan(0);
    expect(out.slice(firstSuggestion).every((o) => o.confidence === "suggestion")).toBe(true);
  });
});

describe("copy", () => {
  it("renders every observation shape in every locale with no placeholders", () => {
    const observations = [
      { code: "no_data", confidence: "observed" },
      { code: "top_channel", confidence: "pattern", label: "Facebook", students: 2 },
      {
        code: "channel_outperforms",
        confidence: "pattern",
        winner: "Facebook",
        loser: "Reddit",
        ratio: 2.4,
      },
      { code: "traffic_no_enquiries", confidence: "pattern", label: "Reddit", visits: 60 },
      { code: "referrals_convert_best", confidence: "pattern", ratio: 3.1 },
      { code: "needs_more_data", confidence: "observed", visits: 4 },
      { code: "try_untried_community", confidence: "suggestion", label: "r/Spanish" },
      { code: "repeat_what_works", confidence: "suggestion", label: "Oaxaca Expats" },
    ] as const;
    for (const locale of ["es-MX", "en", "fr"] as const) {
      for (const o of observations) {
        const text = observationText(o, locale);
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toContain("undefined");
      }
      for (const c of ["observed", "pattern", "suggestion"] as const) {
        expect(confidenceLabel(c, locale).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("funnelSteps", () => {
  const totals = (over: Partial<typeof EMPTY_FUNNEL>) => ({ ...EMPTY_FUNNEL, ...over });

  it("walks visit → checkout → paid, and leaves enquiries out", () => {
    const steps = funnelSteps(totals({ visits: 100, enquiries: 40, bookings: 10, students: 4 }));
    expect(steps.map((s) => s.key)).toEqual(["visits", "bookings", "students"]);
    expect(steps.map((s) => s.count)).toEqual([100, 10, 4]);
  });

  it("measures each step against the top and against the step above it", () => {
    const steps = funnelSteps(totals({ visits: 100, bookings: 10, students: 4 }));
    expect(steps[0]).toMatchObject({ shareOfTop: 1, shareOfPrevious: null, lostFromPrevious: 0 });
    expect(steps[1]).toMatchObject({ shareOfTop: 0.1, shareOfPrevious: 0.1, lostFromPrevious: 90 });
    // 4 of 10 who started checkout paid — 40% of the step above, 4% of visits.
    expect(steps[2]).toMatchObject({
      shareOfTop: 0.04,
      shareOfPrevious: 0.4,
      lostFromPrevious: 6,
    });
  });

  // The shape the teacher in the bug report actually had: traffic, no buyers.
  it("reports a total stall at the first step", () => {
    const steps = funnelSteps(totals({ visits: 301 }));
    expect(steps[1]).toMatchObject({ shareOfTop: 0, lostFromPrevious: 301 });
    expect(steps[2]).toMatchObject({ shareOfTop: 0, shareOfPrevious: null, lostFromPrevious: 0 });
  });

  it("has no rates at all without visits", () => {
    for (const step of funnelSteps(EMPTY_FUNNEL)) {
      expect(step.shareOfTop).toBeNull();
      expect(step.lostFromPrevious).toBe(0);
    }
  });

  // The steps are not strictly nested in time: a checkout inside the window
  // whose visit fell outside it leaves a step larger than the one above.
  it("never reports a negative loss when a step exceeds the one above", () => {
    const steps = funnelSteps(totals({ visits: 2, bookings: 5, students: 1 }));
    expect(steps[1].lostFromPrevious).toBe(0);
    expect(steps[1].shareOfPrevious).toBe(2.5);
    expect(steps[2].lostFromPrevious).toBe(4);
  });
});
