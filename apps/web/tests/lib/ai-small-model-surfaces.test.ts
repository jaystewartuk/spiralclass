import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #30: the four short, structured surfaces (D-87) each hardcoded
// claude-haiku-4-5, so moving them — a rollback included — was a code change
// and a release. Each now asks anthropicSmallModel() at call time, so setting
// ANTHROPIC_SMALL_MODEL moves all four together. This pins that every one of
// them sends whatever the resolver returns, not a constant of its own.

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const anthropicSmallModel = vi.fn(() => "claude-resolved-small");
vi.mock("@/lib/env", () => ({
  anthropicApiKey: () => "sk-test",
  anthropicSmallModel,
}));

const { generateSummaryText } = await import("@/lib/lesson-notes/summary");
const { generateInsights } = await import("@/lib/lesson-notes/insights");
const { generateBrief } = await import("@/lib/lesson-notes/brief");
const { generateIntroCoachFeedback } = await import("@/lib/intro-video/coach");

const SURFACES: { name: string; run: () => Promise<unknown> }[] = [
  {
    name: "lesson summary",
    run: () =>
      generateSummaryText({
        studentName: "Marco",
        when: "12 Jun 2026, 10:00",
        teacherCues: [],
        studentNotes: [],
        language: "English",
      }),
  },
  {
    name: "lesson insights",
    run: () =>
      generateInsights({
        studentName: "Marco",
        targetLanguage: "es",
        utterances: [],
        teacherCues: [],
        studentNotes: [],
        outputLanguage: "English",
      }),
  },
  {
    name: "pre-class brief",
    run: () =>
      generateBrief({
        studentName: "Marco",
        language: "es",
        profile: { byCategory: {}, vocabulary: [], speakingBalance: null },
        outputLanguage: "English",
      }),
  },
  {
    name: "intro-video coach",
    run: () =>
      generateIntroCoachFeedback({
        transcript: "Hola, soy Ana.",
        durationSec: 40,
        language: "English",
      }),
  },
];

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ content: [], model: "claude-resolved-small" });
  anthropicSmallModel.mockClear();
});

describe("the four short AI surfaces", () => {
  for (const surface of SURFACES) {
    it(`${surface.name} sends the model anthropicSmallModel() resolves`, async () => {
      await surface.run().catch(() => undefined);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0]).toMatchObject({ model: "claude-resolved-small" });
      expect(anthropicSmallModel).toHaveBeenCalled();
    });

    // D-87: these calls run on Haiku 4.5 by default, which 400s on `effort`.
    it(`${surface.name} passes no output_config.effort`, async () => {
      await surface.run().catch(() => undefined);
      expect(create.mock.calls[0]![0]).not.toHaveProperty("output_config");
    });
  }
});
