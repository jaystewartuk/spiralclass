import { describe, expect, it } from "vitest";

import {
  emptyIntroVideoWatchState,
  foldIntroVideoTick,
  introVideoLengthVerdict,
  introVideoNewMilestones,
  introVideoWatchSummary,
  INTRO_VIDEO_IDEAL_MAX_SEC,
  INTRO_VIDEO_IDEAL_MIN_SEC,
} from "./intro-video";

describe("introVideoLengthVerdict", () => {
  it("calls the coached window ideal, inclusive at both ends", () => {
    expect(introVideoLengthVerdict(INTRO_VIDEO_IDEAL_MIN_SEC)).toBe("ideal");
    expect(introVideoLengthVerdict(45)).toBe("ideal");
    expect(introVideoLengthVerdict(INTRO_VIDEO_IDEAL_MAX_SEC)).toBe("ideal");
  });

  it("flags a clip under the window as too short", () => {
    expect(introVideoLengthVerdict(29)).toBe("too-short");
    expect(introVideoLengthVerdict(5)).toBe("too-short");
  });

  it("separates slightly-long from too-long at 1.5x the ideal max", () => {
    expect(introVideoLengthVerdict(75)).toBe("slightly-long");
    expect(introVideoLengthVerdict(90)).toBe("slightly-long");
    expect(introVideoLengthVerdict(91)).toBe("too-long");
    expect(introVideoLengthVerdict(300)).toBe("too-long");
  });
});

describe("introVideoNewMilestones", () => {
  it("reports a quartile once it's reached", () => {
    expect(introVideoNewMilestones(15, 60, [])).toEqual([25]);
    expect(introVideoNewMilestones(31, 60, [25])).toEqual([50]);
  });

  it("never repeats a milestone already reported", () => {
    expect(introVideoNewMilestones(31, 60, [25, 50])).toEqual([]);
  });

  it("backfills skipped milestones so a forward seek keeps the funnel gap-free", () => {
    // Seeking straight to 80% must still emit 25 and 50 before 75, otherwise
    // the 25%→50% step would show a drop-off that never happened.
    expect(introVideoNewMilestones(48, 60, [])).toEqual([25, 50, 75]);
  });

  it("returns nothing for an unknown duration, so 0/0 never reads as complete", () => {
    expect(introVideoNewMilestones(0, Number.NaN, [])).toEqual([]);
    expect(introVideoNewMilestones(5, 0, [])).toEqual([]);
  });

  it("ignores a negative/non-finite position", () => {
    expect(introVideoNewMilestones(-1, 60, [])).toEqual([]);
    expect(introVideoNewMilestones(Number.NaN, 60, [])).toEqual([]);
  });
});

describe("foldIntroVideoTick", () => {
  it("accumulates forward playback time", () => {
    let s = emptyIntroVideoWatchState();
    s = foldIntroVideoTick(s, 1, null, 60); // first tick: no credit
    s = foldIntroVideoTick(s, 2, 1, 60);
    s = foldIntroVideoTick(s, 3, 2, 60);
    expect(s.watchedSec).toBeCloseTo(2);
  });

  it("does not credit skipped seconds when the viewer seeks forward", () => {
    let s = emptyIntroVideoWatchState();
    s = foldIntroVideoTick(s, 50, 2, 60); // a 48s jump is a seek, not viewing
    expect(s.watchedSec).toBe(0);
    // ...but the furthest point reached still counts.
    expect(s.maxPercent).toBeCloseTo((50 / 60) * 100);
  });

  it("does not inflate watched time when the viewer scrubs back and rewatches", () => {
    let s = emptyIntroVideoWatchState();
    s = foldIntroVideoTick(s, 30, 29, 60);
    s = foldIntroVideoTick(s, 10, 30, 60); // backwards seek: no credit, no maxPercent loss
    expect(s.watchedSec).toBeCloseTo(1);
    expect(s.maxPercent).toBeCloseTo(50);
  });

  it("keeps maxPercent monotonic and capped at 100", () => {
    let s = emptyIntroVideoWatchState();
    s = foldIntroVideoTick(s, 61, 60, 60); // a hair past the reported duration
    expect(s.maxPercent).toBe(100);
  });

  it("leaves state untouched for a non-finite position", () => {
    const s = emptyIntroVideoWatchState();
    expect(foldIntroVideoTick(s, Number.NaN, 1, 60)).toBe(s);
  });
});

describe("introVideoWatchSummary", () => {
  it("rounds to the shape both platforms report", () => {
    const s = { watchedSec: 12.345, maxPercent: 83.7, playCount: 2, completed: false };
    expect(introVideoWatchSummary(s)).toEqual({
      watched_ms: 12345,
      max_percent: 84,
      play_count: 2,
      completed: false,
    });
  });
});
