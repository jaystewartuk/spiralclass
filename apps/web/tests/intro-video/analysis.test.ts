import { beforeEach, describe, expect, it, vi } from "vitest";

// loadIntroVideoAnalysisState feeds the booking-page editor's live
// processing/success/failure UI (D-73, Layer 3) — richer than
// loadIntroVideoCoach (which only ever returns the feedback, not the
// pipeline's current status/error). No prior coverage existed for either.

const introVideoAnalysisFindUnique = vi.fn(
  async () =>
    null as {
      status: string;
      coachFeedback: unknown;
      error: string | null;
      transcript?: unknown;
    } | null,
);
vi.mock("@/lib/prisma", () => ({
  prisma: { introVideoAnalysis: { findUnique: introVideoAnalysisFindUnique } },
}));

const { loadIntroVideoCoach, loadIntroVideoAnalysisState } =
  await import("@/lib/intro-video/analysis");

beforeEach(() => {
  vi.clearAllMocks();
  introVideoAnalysisFindUnique.mockResolvedValue(null);
});

describe("loadIntroVideoAnalysisState", () => {
  it("reports a null status when no analysis row exists yet", async () => {
    expect(await loadIntroVideoAnalysisState("t1")).toEqual({
      status: null,
      coach: null,
      error: null,
      hasTranscript: false,
    });
  });

  it("surfaces a processing status with no coach feedback yet", async () => {
    introVideoAnalysisFindUnique.mockResolvedValueOnce({
      status: "transcribing",
      coachFeedback: null,
      error: null,
    });
    expect(await loadIntroVideoAnalysisState("t1")).toEqual({
      status: "transcribing",
      coach: null,
      error: null,
      hasTranscript: false,
    });
  });

  it("surfaces a failure reason", async () => {
    introVideoAnalysisFindUnique.mockResolvedValueOnce({
      status: "failed",
      coachFeedback: null,
      error: "transcription-failed",
    });
    const res = await loadIntroVideoAnalysisState("t1");
    expect(res.status).toBe("failed");
    expect(res.error).toBe("transcription-failed");
  });

  it("surfaces the completed coach feedback", async () => {
    const coach = { overall: "Nice!", strengths: ["Clear"], improvements: ["Shorter"] };
    introVideoAnalysisFindUnique.mockResolvedValueOnce({
      status: "transcribed",
      coachFeedback: coach,
      error: null,
      transcript: null,
    });
    const res = await loadIntroVideoAnalysisState("t1");
    expect(res.status).toBe("transcribed");
    expect(res.coach).toEqual(coach);
    // No transcript on this row (e.g. ASR ran but produced nothing usable) —
    // the Settings toggle stays hidden.
    expect(res.hasTranscript).toBe(false);
  });

  // Booking-page AI-readability: Settings only shows the publish opt-in once
  // a real transcript exists — this is the flag that decides that.
  it("reports hasTranscript true once a non-empty transcript exists", async () => {
    introVideoAnalysisFindUnique.mockResolvedValueOnce({
      status: "transcribed",
      coachFeedback: null,
      error: null,
      transcript: [{ text: "Hi, I'm Mira.", startMs: 0, endMs: 1000 }],
    });
    const res = await loadIntroVideoAnalysisState("t1");
    expect(res.hasTranscript).toBe(true);
  });
});

describe("loadIntroVideoCoach", () => {
  it("returns null until feedback has been generated", async () => {
    expect(await loadIntroVideoCoach("t1")).toBeNull();
  });

  it("returns the stored coach feedback", async () => {
    const coach = { overall: "Nice!", strengths: [], improvements: [] };
    introVideoAnalysisFindUnique.mockResolvedValueOnce({
      status: "transcribed",
      coachFeedback: coach,
      error: null,
    });
    expect(await loadIntroVideoCoach("t1")).toEqual(coach);
  });
});
