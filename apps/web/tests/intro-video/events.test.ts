import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared server-side intro-video analytics (D-73). Both the web Server Action
// every caller emits through this, so the property shape can't drift
// between surfaces — a funnel spanning both is only meaningful if the events
// are otherwise identical.

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { introVideoAnalysis: { findUnique } },
}));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent }));

const { readPriorCoachSignal, trackIntroVideoSet, trackIntroVideoRemoved } =
  await import("@/lib/intro-video/events");

const NO_COACH = { hadCoachFeedback: false, coachFeedbackAgeMs: null };

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
});

describe("readPriorCoachSignal", () => {
  it("reports no signal when the teacher has never been analysed", async () => {
    expect(await readPriorCoachSignal("t1")).toEqual(NO_COACH);
  });

  it("reports no signal when a row exists but carries no feedback", async () => {
    // Transcribed but the Anthropic call failed — there was nothing to act on.
    findUnique.mockResolvedValue({ coachFeedback: null, updatedAt: new Date() });
    expect(await readPriorCoachSignal("t1")).toEqual(NO_COACH);
  });

  it("measures how long ago the feedback landed", async () => {
    const now = 1_000_000;
    findUnique.mockResolvedValue({
      coachFeedback: { overall: "ok", strengths: [], improvements: [] },
      updatedAt: new Date(now - 90_000),
    });
    expect(await readPriorCoachSignal("t1", now)).toEqual({
      hadCoachFeedback: true,
      coachFeedbackAgeMs: 90_000,
    });
  });

  it("degrades to no-signal rather than failing the save when the read errors", async () => {
    // Analytics must never be the reason a teacher can't publish her video.
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await readPriorCoachSignal("t1")).toEqual(NO_COACH);
  });
});

describe("trackIntroVideoSet", () => {
  const base = {
    teacherId: "t1",
    surface: "web" as const,
    source: "record" as const,
    durationMs: 45_000,
    sizeBytes: 2_000_000,
  };

  it("nulls the coach properties on a FIRST video", async () => {
    // `false` would read as "she ignored the advice"; there was no advice.
    trackIntroVideoSet({
      ...base,
      isReplacement: false,
      prior: { hadCoachFeedback: true, coachFeedbackAgeMs: 500 },
    });
    const props = trackServerEvent.mock.calls[0][0].properties;
    expect(props.afterCoachFeedback).toBeNull();
    expect(props.coachFeedbackAgeMs).toBeNull();
  });

  it("carries the coach signal on a replacement — the act-on-advice measurement", () => {
    trackIntroVideoSet({
      ...base,
      isReplacement: true,
      prior: { hadCoachFeedback: true, coachFeedbackAgeMs: 120_000 },
    });
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "teacher_intro_video_set",
      distinctId: "t1",
      properties: {
        teacherId: "t1",
        durationMs: 45_000,
        surface: "web",
        source: "record",
        sizeBytes: 2_000_000,
        isReplacement: true,
        afterCoachFeedback: true,
        coachFeedbackAgeMs: 120_000,
      },
    });
  });

  it("emits the identical property set from the mobile surface", () => {
    trackIntroVideoSet({ ...base, surface: "mobile", isReplacement: false, prior: NO_COACH });
    expect(Object.keys(trackServerEvent.mock.calls[0][0].properties).sort()).toEqual([
      "afterCoachFeedback",
      "coachFeedbackAgeMs",
      "durationMs",
      "isReplacement",
      "sizeBytes",
      "source",
      "surface",
      "teacherId",
    ]);
  });
});

describe("trackIntroVideoRemoved", () => {
  it("records whether the deleted video had been coached", () => {
    // A teacher who deletes right after reading harsh feedback is a signal
    // about the coach's tone, not only about the video.
    trackIntroVideoRemoved({ teacherId: "t1", surface: "web", hadCoachFeedback: true });
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "teacher_intro_video_removed",
      distinctId: "t1",
      properties: { teacherId: "t1", surface: "web", hadCoachFeedback: true },
    });
  });
});
