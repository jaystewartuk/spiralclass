import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  processIntroVideoReady,
  type IntroVideoTranscribeDeps,
} from "@/lib/intro-video/transcribe";
import type { Utterance } from "@/lib/transcription/types";

// Layer 2 pipeline (D-73): teacher's public intro video → transcript, Pro-gated,
// on the Inngest rail. All I/O is injected, so these drive the branch matrix
// (no video / stale / not-Pro / success / failure) against stub deps.

const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIDEO_PATH = TEACHER_ID; // one object per teacher, keyed by id

const UTTS: Utterance[] = [{ text: "Hola, soy Mira.", startMs: 0, endMs: 1500, words: [] }];

function makeDeps(overrides: {
  teacher: {
    introVideoPath: string | null;
    // The language she SPEAKS (ASR source). Deliberately not `targetLanguage`,
    // which is the subject she teaches — conflating the two is the bug these
    // tests now pin down.
    teachingLanguage: string | null;
    // Her UI language, which is what the coach must write feedback in.
    locale?: string | null;
    // The SUBJECT she teaches (D-72). Present in fixtures only so a test can
    // prove the pipeline ignores it — it is deliberately not selected.
    targetLanguage?: string | null;
    introVideoDurationMs?: number | null;
  } | null;
  canUseCoach?: boolean;
  transcribe?: () => Promise<{ utterances: Utterance[]; provider: string }>;
  generateFeedback?: IntroVideoTranscribeDeps["generateFeedback"];
}): {
  deps: IntroVideoTranscribeDeps;
  findUnique: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
  generateFeedback: ReturnType<typeof vi.fn> | undefined;
  onOutcome: ReturnType<typeof vi.fn>;
  onFailure: ReturnType<typeof vi.fn>;
} {
  const findUnique = vi
    .fn()
    .mockResolvedValue(
      overrides.teacher
        ? { id: TEACHER_ID, updatedAt: new Date("2026-01-01T00:00:00Z"), ...overrides.teacher }
        : null,
    );
  const upsert = vi.fn().mockResolvedValue({});
  const update = vi.fn().mockResolvedValue({});
  const transcribe = vi.fn(
    overrides.transcribe ?? (async () => ({ utterances: UTTS, provider: "deepgram" })),
  );
  const generateFeedback = overrides.generateFeedback
    ? vi.fn(overrides.generateFeedback)
    : undefined;
  const onOutcome = vi.fn();
  const onFailure = vi.fn();

  const deps: IntroVideoTranscribeDeps = {
    prisma: {
      teacher: { findUnique } as never,
      introVideoAnalysis: { upsert, update } as never,
    },
    provider: { vendor: "deepgram", transcribe },
    canUseCoach: vi.fn().mockResolvedValue(overrides.canUseCoach ?? true),
    generateFeedback,
    onOutcome,
    onFailure,
    // Frozen clock so latency assertions are deterministic.
    now: () => 1_000,
  };
  return { deps, findUnique, upsert, update, transcribe, generateFeedback, onOutcome, onFailure };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL", "https://vid.r2.dev");
});
afterEach(() => vi.unstubAllEnvs());

describe("processIntroVideoReady", () => {
  it("skips when the teacher has no intro video", async () => {
    const { deps, transcribe } = makeDeps({
      teacher: { introVideoPath: null, teachingLanguage: "es" },
    });
    const res = await processIntroVideoReady(deps, {
      teacherId: TEACHER_ID,
      videoPath: VIDEO_PATH,
    });
    expect(res).toEqual({ ok: true, skipped: "no-video" });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("skips a stale event whose videoPath no longer matches", async () => {
    const { deps, transcribe } = makeDeps({
      teacher: { introVideoPath: "current-key", teachingLanguage: "es" },
    });
    const res = await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: "old-key" });
    expect(res).toEqual({ ok: true, skipped: "stale" });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("skips a non-Pro teacher without spending vendor minutes", async () => {
    const { deps, transcribe, upsert } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es" },
      canUseCoach: false,
    });
    const res = await processIntroVideoReady(deps, {
      teacherId: TEACHER_ID,
      videoPath: VIDEO_PATH,
    });
    expect(res).toEqual({ ok: true, skipped: "not-pro" });
    expect(transcribe).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns no-public-url when the storage bucket URL is unconfigured", async () => {
    vi.stubEnv("NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL", "");
    const { deps, transcribe } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es" },
    });
    const res = await processIntroVideoReady(deps, {
      teacherId: TEACHER_ID,
      videoPath: VIDEO_PATH,
    });
    expect(res).toEqual({ ok: false, reason: "no-public-url" });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("transcribes the public URL and stores the transcript (marks transcribing → transcribed)", async () => {
    const { deps, transcribe, upsert, update } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es-419" },
    });
    const res = await processIntroVideoReady(deps, {
      teacherId: TEACHER_ID,
      videoPath: VIDEO_PATH,
    });

    // Vendor was handed the stable public URL + the language she SPEAKS.
    expect(transcribe).toHaveBeenCalledWith({
      audioUrl: expect.stringContaining("https://vid.r2.dev/"),
      language: "es-419",
    });
    // Row marked transcribing first…
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: TEACHER_ID },
        update: expect.objectContaining({ status: "transcribing", language: "es-419" }),
      }),
    );
    // …then the transcript is written with status transcribed + provenance.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: TEACHER_ID },
        data: expect.objectContaining({
          status: "transcribed",
          provider: "deepgram",
          transcript: UTTS,
        }),
      }),
    );
    expect(res).toEqual({ ok: true, utterances: 1 });
  });

  it("defaults the ASR language to Spanish when the teacher has no teaching language", async () => {
    const { deps, transcribe } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: null },
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: "es" }));
  });

  it("generates coach feedback from the joined transcript and stores it (Layer 3)", async () => {
    const feedback = {
      overall: "Cálida y clara.",
      strengths: ["Buena energía"],
      improvements: ["Di para quién son las clases"],
    };
    const { deps, generateFeedback, update } = makeDeps({
      teacher: {
        introVideoPath: VIDEO_PATH,
        teachingLanguage: "es",
        // Her UI language is what decides the feedback language now — it used
        // to be inferred from the ASR language, which is a different question.
        locale: "es-MX",
        introVideoDurationMs: 45000,
      },
      generateFeedback: async () => feedback,
    });
    const res = await processIntroVideoReady(deps, {
      teacherId: TEACHER_ID,
      videoPath: VIDEO_PATH,
    });

    // Fed the joined utterance text, duration in whole seconds, and her
    // es-MX locale → en:false.
    expect(generateFeedback).toHaveBeenCalledWith({
      transcript: "Hola, soy Mira.",
      durationSec: 45,
      en: false,
    });
    // …then the feedback is persisted on the analysis row.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: TEACHER_ID },
        data: { coachFeedback: feedback },
      }),
    );
    expect(res).toEqual({ ok: true, utterances: 1 });
  });

  it("passes en:true for an English-locale teacher and null duration when unknown", async () => {
    const { deps, generateFeedback } = makeDeps({
      teacher: {
        introVideoPath: VIDEO_PATH,
        teachingLanguage: "en-US",
        locale: "en",
        introVideoDurationMs: null,
      },
      generateFeedback: async () => ({ overall: "Nice.", strengths: [], improvements: [] }),
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    expect(generateFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ en: true, durationSec: null }),
    );
  });

  it("does not store coach feedback when the generator returns null (unparseable)", async () => {
    const { deps, update } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es" },
      generateFeedback: async () => null,
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    // Only the transcript write happened — no coachFeedback update.
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coachFeedback: expect.anything() }),
      }),
    );
  });

  it("still succeeds (transcript kept) when coach generation throws — best-effort", async () => {
    const { deps, update } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es" },
      generateFeedback: async () => {
        throw new Error("anthropic-529");
      },
    });
    const res = await processIntroVideoReady(deps, {
      teacherId: TEACHER_ID,
      videoPath: VIDEO_PATH,
    });
    expect(res).toEqual({ ok: true, utterances: 1 });
    // Transcript was still stored despite the coach failure.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "transcribed" }) }),
    );
  });

  it("marks the row failed and rethrows when the vendor errors (so Inngest retries)", async () => {
    const { deps, update } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es" },
      transcribe: async () => {
        throw new Error("deepgram-http-503");
      },
    });
    await expect(
      processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH }),
    ).rejects.toThrow("deepgram-http-503");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: TEACHER_ID },
        data: expect.objectContaining({ status: "failed", error: "deepgram-http-503" }),
      }),
    );
  });
});

// The pipeline used to read `targetLanguage` — the SUBJECT the teacher teaches
// (D-72) — for BOTH the ASR language and the coach's output language. Those are
// two different questions and neither of them is "what subject does she teach".
//
// The conflation is INVISIBLE whenever a teacher's subject and her spoken
// language coincide — a teacher of Spanish who teaches in Spanish has both
// columns set to "es", so the old code happened to produce the right answer.
// It breaks as soon as they diverge, which is the whole point of the platform
// being language-first: a teacher of English who teaches in Spanish had her
// Spanish audio sent to Deepgram tagged `en` (garbage transcript) and her
// feedback written in English. These pin the two questions to two columns so
// the coincidence can never be mistaken for correctness again.
describe("language resolution", () => {
  it("transcribes in the language she SPEAKS, not the subject she teaches", async () => {
    // The case the old code got WRONG: a teacher OF English who teaches IN
    // Spanish. `targetLanguage: "en"` is present on the row and must be
    // ignored — reading it here sent Spanish audio to the vendor tagged `en`.
    const { deps, transcribe } = makeDeps({
      teacher: {
        introVideoPath: VIDEO_PATH,
        teachingLanguage: "es",
        targetLanguage: "en",
        locale: "es-MX",
      },
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: "es" }));
  });

  it("ignores the subject when choosing the feedback language too", async () => {
    // The same divergent teacher: subject English, speaks Spanish, Spanish UI.
    // Under the old code the subject drove BOTH decisions, so she also got her
    // coaching written in English.
    const { deps, generateFeedback } = makeDeps({
      teacher: {
        introVideoPath: VIDEO_PATH,
        teachingLanguage: "es",
        targetLanguage: "en",
        locale: "es-MX",
        introVideoDurationMs: 40000,
      },
      generateFeedback: async () => ({ overall: "ok", strengths: [], improvements: [] }),
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    expect(generateFeedback).toHaveBeenCalledWith(expect.objectContaining({ en: false }));
  });

  it("writes feedback in her UI locale, not the language of the audio", async () => {
    // The coinciding case (teaches Spanish, in Spanish, Spanish UI) — the one
    // the old code got right by accident. Pinned so a future refactor that
    // re-merges the columns still passes here and fails the divergent cases
    // below, rather than the other way round.
    const { deps, generateFeedback } = makeDeps({
      teacher: {
        introVideoPath: VIDEO_PATH,
        teachingLanguage: "es",
        locale: "es-MX",
        introVideoDurationMs: 40000,
      },
      generateFeedback: async () => ({ overall: "ok", strengths: [], improvements: [] }),
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    expect(generateFeedback).toHaveBeenCalledWith(expect.objectContaining({ en: false }));
  });

  it("writes English feedback about a Spanish-spoken clip for an English-locale teacher", async () => {
    // A divergent case, proving the two axes are genuinely independent: audio
    // in Spanish, feedback in English, because that is her UI language.
    const { deps, transcribe, generateFeedback } = makeDeps({
      teacher: {
        introVideoPath: VIDEO_PATH,
        teachingLanguage: "es",
        locale: "en",
        introVideoDurationMs: 40000,
      },
      generateFeedback: async () => ({ overall: "ok", strengths: [], improvements: [] }),
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: "es" }));
    expect(generateFeedback).toHaveBeenCalledWith(expect.objectContaining({ en: true }));
  });
});

describe("analysis telemetry", () => {
  it("reports a successful run with the coach flag and provider", async () => {
    const { deps, onOutcome } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es", introVideoDurationMs: 45000 },
      generateFeedback: async () => ({ overall: "ok", strengths: [], improvements: [] }),
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: TEACHER_ID,
        outcome: "transcribed",
        coachGenerated: true,
        utterances: 1,
        durationSec: 45,
        provider: "deepgram",
      }),
    );
  });

  it("distinguishes a transcript with NO usable coach feedback from a coached one", async () => {
    // The silent-degradation path: ASR worked, the Anthropic call returned
    // something unparseable. Without this flag it is indistinguishable from a
    // fully successful run.
    const { deps, onOutcome } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es" },
      generateFeedback: async () => null,
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "transcribed", coachGenerated: false }),
    );
  });

  it("reports the Pro-gate skip — the upgrade-intent signal for the whole feature", async () => {
    const { deps, onOutcome } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es" },
      canUseCoach: false,
    });
    await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not-pro" }));
  });

  it("reports every benign skip, so the funnel has no silent holes", async () => {
    for (const [teacher, outcome] of [
      [{ introVideoPath: null, teachingLanguage: "es" }, "no-video"],
      [{ introVideoPath: "some-other-key", teachingLanguage: "es" }, "stale"],
    ] as const) {
      const { deps, onOutcome } = makeDeps({ teacher });
      await processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH });
      expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
    }
  });

  it("reports a vendor failure BEFORE re-throwing for the Inngest retry", async () => {
    const { deps, onFailure, onOutcome } = makeDeps({
      teacher: { introVideoPath: VIDEO_PATH, teachingLanguage: "es" },
      transcribe: async () => {
        throw new Error("deepgram 503");
      },
    });
    await expect(
      processIntroVideoReady(deps, { teacherId: TEACHER_ID, videoPath: VIDEO_PATH }),
    ).rejects.toThrow("deepgram 503");
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: TEACHER_ID, reason: "deepgram 503" }),
    );
    // A failure is NOT also a completion — otherwise the failure rate would be
    // a filter on an outcome property rather than a straight ratio.
    expect(onOutcome).not.toHaveBeenCalled();
  });
});
