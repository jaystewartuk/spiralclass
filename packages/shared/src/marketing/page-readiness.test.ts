import { describe, expect, it } from "vitest";
import { EMPTY_FUNNEL } from "./insights";
import {
  MIN_USEFUL_BIO_CHARS,
  MIN_VISITS_TO_JUDGE_PAGE,
  pageGaps,
  pageReadiness,
  type PageSignals,
} from "./page-readiness";

const READY: PageSignals = {
  hasPhoto: true,
  headline: "Spanish for expats in Mexico",
  bio: "x".repeat(MIN_USEFUL_BIO_CHARS),
  packageCount: 3,
  testimonialCount: 2,
  hasIntroVideo: true,
  introVideoOfferable: true,
};

const funnel = (over: Partial<typeof EMPTY_FUNNEL>) => ({ ...EMPTY_FUNNEL, ...over });
const codes = (s: PageSignals) => pageGaps(s).map((g) => g.code);

describe("pageGaps", () => {
  it("finds nothing wrong with a complete page", () => {
    expect(pageGaps(READY)).toEqual([]);
  });

  it("treats having nothing to sell as blocking, and puts it first", () => {
    const gaps = pageGaps({ ...READY, packageCount: 0, hasPhoto: false });
    expect(gaps[0]).toMatchObject({ code: "no_packages", severity: "blocking" });
  });

  it("orders important gaps ahead of polish", () => {
    const gaps = pageGaps({
      ...READY,
      hasPhoto: false,
      testimonialCount: 0,
      hasIntroVideo: false,
    });
    expect(gaps.map((g) => g.severity)).toEqual(["important", "polish", "polish"]);
    expect(gaps[0].code).toBe("no_photo");
  });

  it("separates a missing bio from one too short to do anything", () => {
    expect(codes({ ...READY, bio: null })).toContain("no_bio");
    expect(codes({ ...READY, bio: "   " })).toContain("no_bio");
    const thin = codes({ ...READY, bio: "Teacher." });
    expect(thin).toContain("thin_bio");
    expect(thin).not.toContain("no_bio");
    expect(codes({ ...READY, bio: "y".repeat(MIN_USEFUL_BIO_CHARS) })).toEqual([]);
  });

  // Asking for a video the deploy cannot store is a chore she cannot finish.
  it("never asks for an intro video the deploy cannot accept", () => {
    expect(codes({ ...READY, hasIntroVideo: false, introVideoOfferable: false })).toEqual([]);
    expect(codes({ ...READY, hasIntroVideo: false, introVideoOfferable: true })).toEqual([
      "no_intro_video",
    ]);
  });

  it("sends each gap somewhere in-app that actually fixes it", () => {
    for (const gap of pageGaps({
      hasPhoto: false,
      headline: null,
      bio: null,
      packageCount: 0,
      testimonialCount: 0,
      hasIntroVideo: false,
      introVideoOfferable: true,
    })) {
      expect(gap.href.startsWith("/")).toBe(true);
    }
  });
});

describe("pageReadiness", () => {
  it("says the page is ready when nothing is missing", () => {
    const r = pageReadiness(READY, funnel({ visits: 300 }));
    expect(r.verdict).toBe("ready");
    expect(r.isBottleneck).toBe(false);
  });

  // The shape from the report: real traffic arriving, nobody reaching checkout.
  it("calls the page the bottleneck when real traffic never starts checkout", () => {
    const r = pageReadiness({ ...READY, hasPhoto: false }, funnel({ visits: 28 }));
    expect(r.verdict).toBe("traffic_not_converting");
    expect(r.isBottleneck).toBe(true);
    expect(r.visits).toBe(28);
  });

  // The floor is the whole point: below it, zero checkouts is a small sample,
  // not evidence, and saying otherwise is ranking noise.
  it("will not blame the page on too little traffic to judge it", () => {
    const r = pageReadiness({ ...READY, hasPhoto: false }, funnel({ visits: 3 }));
    expect(r.verdict).toBe("not_enough_traffic");
    expect(r.isBottleneck).toBe(false);
  });

  it("holds that line exactly at the floor", () => {
    const thin = { ...READY, hasPhoto: false };
    expect(pageReadiness(thin, funnel({ visits: MIN_VISITS_TO_JUDGE_PAGE - 1 })).verdict).toBe(
      "not_enough_traffic",
    );
    expect(pageReadiness(thin, funnel({ visits: MIN_VISITS_TO_JUDGE_PAGE })).verdict).toBe(
      "traffic_not_converting",
    );
  });

  it("stops blaming the page as soon as someone reaches checkout", () => {
    const r = pageReadiness({ ...READY, hasPhoto: false }, funnel({ visits: 300, bookings: 1 }));
    expect(r.verdict).toBe("not_enough_traffic");
    expect(r.isBottleneck).toBe(false);
  });

  // Nothing to buy is a fact about the page, not a claim about the funnel, so
  // it outranks everything and needs no traffic to be true.
  it("flags an unbuyable page with no traffic at all", () => {
    const r = pageReadiness({ ...READY, packageCount: 0 }, EMPTY_FUNNEL);
    expect(r.verdict).toBe("cannot_buy");
    expect(r.isBottleneck).toBe(true);
  });
});
