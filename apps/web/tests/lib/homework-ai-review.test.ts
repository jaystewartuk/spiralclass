import { beforeEach, describe, expect, it, vi } from "vitest";

// ai-review.ts is a server module (`import "server-only"`); neutralize the
// guard, same pattern as homework-feedback.test.ts. Covers the shared
// business logic behind BOTH the mobile teacher route and the web review
// action (docs/features/homework.md): the Pro gate, the
// monthly cap, material-excerpt resolution, and draft persistence.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/storage/homework-file", () => ({
  mintSubmissionSignedUrl: vi.fn(async () => "https://cdn.test/answer.txt"),
}));

vi.mock("@/lib/env", () => ({
  anthropicModel: () => "claude-sonnet-5",
}));

const getTranscriptionProvider = vi.fn(
  () => null as { vendor: string; transcribe: unknown } | null,
);
vi.mock("@/lib/transcription/provider", () => ({
  getTranscriptionProvider: () => getTranscriptionProvider(),
}));

// homeworkAudioTranscriptionEnabled() also requires a real vendor API key
// (DEEPGRAM_API_KEY/ASSEMBLYAI_API_KEY) in process.env, which unit tests never
// set — mock the gate directly instead of relying on env plumbing, same as
// getTranscriptionProvider above.
const homeworkAudioTranscriptionEnabled = vi.fn(() => false);
vi.mock("@/lib/transcription/config", () => ({
  DEFAULT_LESSON_LANGUAGE: "es",
  homeworkAudioTranscriptionEnabled: () => homeworkAudioTranscriptionEnabled(),
}));

const TEACHER = { id: "t1" };

const ATTEMPT = {
  id: "at1",
  attemptNumber: 1,
  textResponse: "My answer text",
  files: [],
  submission: {
    id: "sub1",
    assignmentId: "a1",
    studentId: "s1",
    teacherId: "t1",
    assignment: {
      bookingId: "b1",
      title: "Essay",
      instructions: "Write 5 sentences.",
      sourceMaterialId: null,
    },
  },
};

const resolveTeacherAttempt = vi.fn(async (..._: unknown[]) => ATTEMPT as unknown);
vi.mock("@/lib/homework/access", () => ({
  resolveTeacherAttempt: (...a: unknown[]) => resolveTeacherAttempt(...a),
}));

const gateProFeature = vi.fn(async (..._: unknown[]) => ({ ok: true }) as unknown);
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: (...a: unknown[]) => gateProFeature(...a),
  upgradeNudge: () => "Upgrade to Pro.",
}));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: (...a: unknown[]) => trackServerEvent(...a),
}));

const REVIEW_CONTENT = {
  corrections: ["Fix subject-verb agreement in sentence 2."],
  strengths: ["Good vocabulary range."],
  weaknesses: ["Repeats the same connector."],
  grammarNotes: null,
  suggestedFeedback: "Nice work overall!",
  suggestedScore: 8,
};

const generateHomeworkAiReview = vi.fn(
  async (..._: unknown[]) => ({ ok: true, content: REVIEW_CONTENT }) as unknown,
);
vi.mock("@/lib/ai/anthropic", () => ({
  generateHomeworkAiReview: (...a: unknown[]) => generateHomeworkAiReview(...a),
}));

const aiReviewCount = vi.fn(async (..._: unknown[]) => 0);
const aiReviewCreate = vi.fn(
  async (..._: unknown[]) =>
    ({
      id: "draft1",
      instructions: null,
      content: REVIEW_CONTENT,
      model: "claude-sonnet-5",
      createdAt: new Date("2026-07-25T00:00:00Z"),
    }) as unknown,
);
const materialFindUnique = vi.fn(async (..._: unknown[]) => null as unknown);

const prismaMock = {
  homeworkAiReviewDraft: {
    count: (...a: unknown[]) => aiReviewCount(...a),
    create: (...a: unknown[]) => aiReviewCreate(...a),
  },
  libraryMaterial: { findUnique: (...a: unknown[]) => materialFindUnique(...a) },
};
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const { requestHomeworkAiReview } = await import("@/lib/homework/ai-review");

beforeEach(() => {
  vi.clearAllMocks();
  getTranscriptionProvider.mockReturnValue(null);
  homeworkAudioTranscriptionEnabled.mockReturnValue(false);
  gateProFeature.mockResolvedValue({ ok: true });
  aiReviewCount.mockResolvedValue(0);
  generateHomeworkAiReview.mockResolvedValue({ ok: true, content: REVIEW_CONTENT });
  aiReviewCreate.mockResolvedValue({
    id: "draft1",
    instructions: null,
    content: REVIEW_CONTENT,
    model: "claude-sonnet-5",
    createdAt: new Date("2026-07-25T00:00:00Z"),
  });
  materialFindUnique.mockResolvedValue(null);
});

describe("requestHomeworkAiReview", () => {
  it("blocks a Free teacher with a not-pro upgrade nudge", async () => {
    gateProFeature.mockResolvedValue({ ok: false, limit: "homework_review" });
    const result = await requestHomeworkAiReview(TEACHER as never, "at1", {}, "en");
    expect(result).toMatchObject({ ok: false, code: "not-pro" });
    expect(generateHomeworkAiReview).not.toHaveBeenCalled();
  });

  it("blocks once the monthly cap is reached", async () => {
    aiReviewCount.mockResolvedValue(100);
    const result = await requestHomeworkAiReview(TEACHER as never, "at1", {}, "en");
    expect(result).toMatchObject({ ok: false, code: "cap" });
    expect(generateHomeworkAiReview).not.toHaveBeenCalled();
  });

  it("persists a new draft on success and returns it on the wire", async () => {
    const result = await requestHomeworkAiReview(TEACHER as never, "at1", {}, "en");
    expect(result).toMatchObject({ ok: true, draft: { id: "draft1", content: REVIEW_CONTENT } });
    expect(aiReviewCreate).toHaveBeenCalledWith({
      data: {
        attemptId: "at1",
        teacherId: "t1",
        instructions: null,
        content: REVIEW_CONTENT,
        model: "claude-sonnet-5",
      },
    });
  });

  it("passes the attempt text and assignment context into the prompt inputs", async () => {
    await requestHomeworkAiReview(
      TEACHER as never,
      "at1",
      { instructions: "focus on tenses" },
      "en",
    );
    expect(generateHomeworkAiReview).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentTitle: "Essay",
        assignmentInstructions: "Write 5 sentences.",
        attemptText: "My answer text",
        materialExcerpt: null,
        teacherInstructions: "focus on tenses",
        en: true,
      }),
    );
  });

  it("never transcribes audio attachments when the homework-audio flag is off (default test env)", async () => {
    const AUDIO_ATTEMPT = {
      ...ATTEMPT,
      files: [{ id: "f1", fileType: "audio/mpeg", fileName: "answer.mp3", storagePath: "p" }],
    };
    resolveTeacherAttempt.mockResolvedValueOnce(AUDIO_ATTEMPT as never);
    await requestHomeworkAiReview(TEACHER as never, "at1", {}, "en");
    expect(getTranscriptionProvider).not.toHaveBeenCalled();
    expect(generateHomeworkAiReview).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentTexts: [] }),
    );
  });

  it("transcribes an audio attachment when a provider is configured and the flag is on", async () => {
    homeworkAudioTranscriptionEnabled.mockReturnValue(true);
    const transcribe = vi.fn(async () => ({ utterances: [{ text: "hola mundo" }] }));
    getTranscriptionProvider.mockReturnValue({ vendor: "deepgram", transcribe } as never);
    const AUDIO_ATTEMPT = {
      ...ATTEMPT,
      files: [{ id: "f1", fileType: "audio/mpeg", fileName: "answer.mp3", storagePath: "p" }],
    };
    resolveTeacherAttempt.mockResolvedValueOnce(AUDIO_ATTEMPT as never);
    await requestHomeworkAiReview(TEACHER as never, "at1", {}, "en");
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ audioUrl: "https://cdn.test/answer.txt" }),
    );
    expect(generateHomeworkAiReview).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentTexts: [{ fileName: "answer.mp3", text: "hola mundo" }],
      }),
    );
  });

  it("surfaces not-configured when no Anthropic key is set", async () => {
    generateHomeworkAiReview.mockResolvedValue({ ok: false, reason: "not-configured" });
    const result = await requestHomeworkAiReview(TEACHER as never, "at1", {}, "en");
    expect(result).toMatchObject({ ok: false, code: "not-configured" });
    expect(aiReviewCreate).not.toHaveBeenCalled();
  });

  it("tracks generation with the excerpt/attachment/instructions signal", async () => {
    await requestHomeworkAiReview(TEACHER as never, "at1", {}, "en");
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "homework_ai_review_generated",
        properties: expect.objectContaining({
          teacherId: "t1",
          assignmentId: "a1",
          attemptId: "at1",
          hasMaterialExcerpt: false,
          attachmentTextCount: 0,
          hasTeacherInstructions: false,
        }),
      }),
    );
  });
});
