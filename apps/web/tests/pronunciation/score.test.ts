import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  scoreAndStorePronunciation,
  toStoredPronunciation,
  WEAK_WORD_ACCURACY_THRESHOLD,
  type ScoreDeps,
} from "@/lib/pronunciation/score";
import type { PronunciationResult } from "@/lib/pronunciation/types";

const RESULT: PronunciationResult = {
  provider: "azure",
  overall: { accuracy: 80, fluency: 75, completeness: 90, pron: 78 },
  words: [
    { word: "hola", accuracy: 95, startMs: 500, endMs: 800 },
    {
      word: "subjuntivo",
      accuracy: 40,
      startMs: 1000,
      endMs: 1500,
      phonemes: [{ phoneme: "x", accuracy: 30 }],
    },
    { word: "estar", accuracy: 55, startMs: 2000, endMs: 2300 },
  ],
};

describe("toStoredPronunciation", () => {
  it("keeps only sub-threshold words, worst first, with overall", () => {
    const stored = toStoredPronunciation(RESULT);
    expect(stored.overall.pron).toBe(78);
    // 'hola' (95) is above threshold; 'subjuntivo' (40) + 'estar' (55) kept, worst first.
    expect(stored.weakWords.map((w) => w.word)).toEqual(["subjuntivo", "estar"]);
    expect(stored.weakWords[0]).toEqual({
      word: "subjuntivo",
      accuracy: 40,
      atMs: 1000,
      phonemes: [{ phoneme: "x", accuracy: 30 }],
    });
    expect(WEAK_WORD_ACCURACY_THRESHOLD).toBe(60);
  });
});

function makeDb() {
  const upserts: any[] = [];
  return {
    upserts,
    db: {
      lessonPronunciation: {
        upsert: vi.fn(async (args: any) => {
          upserts.push(args);
          return {};
        }),
      },
    },
  };
}

const ARGS = {
  bookingId: "b1",
  teacherId: "t1",
  audioUrl: "https://r2.example/student.ogg",
  referenceText: "hola subjuntivo estar",
  language: "es",
};

function deps(over: Partial<ScoreDeps> = {}): ScoreDeps {
  return {
    enabled: () => true,
    isSupported: () => true,
    getProvider: () => ({ provider: "azure", score: vi.fn(async () => RESULT) }),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("scoreAndStorePronunciation", () => {
  it("scores and upserts the booking's row, storing condensed weak words", async () => {
    const { db, upserts } = makeDb();
    const out = await scoreAndStorePronunciation(db as any, ARGS, deps());
    expect(out).toEqual({ code: "scored", weakWords: 2 });
    expect(upserts[0].where).toEqual({ bookingId: "b1" });
    expect(upserts[0].create.provider).toBe("azure");
    expect((upserts[0].create.scores as any).weakWords).toHaveLength(2);
  });

  it("skips when disabled (no scoring, no upsert)", async () => {
    const { db, upserts } = makeDb();
    const out = await scoreAndStorePronunciation(db as any, ARGS, deps({ enabled: () => false }));
    expect(out).toEqual({ code: "skipped", reason: "disabled" });
    expect(upserts).toHaveLength(0);
  });

  it("skips an unsupported language", async () => {
    const { db } = makeDb();
    const out = await scoreAndStorePronunciation(
      db as any,
      { ...ARGS, language: "ja" },
      deps({ isSupported: () => false }),
    );
    expect(out).toEqual({ code: "skipped", reason: "language-unsupported" });
  });

  it("skips when no provider is configured", async () => {
    const { db } = makeDb();
    const out = await scoreAndStorePronunciation(
      db as any,
      ARGS,
      deps({ getProvider: () => null }),
    );
    expect(out).toEqual({ code: "skipped", reason: "no-provider" });
  });

  it("skips when the reference text is empty", async () => {
    const { db } = makeDb();
    const out = await scoreAndStorePronunciation(
      db as any,
      { ...ARGS, referenceText: "  " },
      deps(),
    );
    expect(out).toEqual({ code: "skipped", reason: "no-reference-text" });
  });
});
