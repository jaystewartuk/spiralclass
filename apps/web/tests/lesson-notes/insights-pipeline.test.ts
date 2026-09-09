import { beforeEach, describe, expect, it, vi } from "vitest";

// Importing the pipeline pulls in the Inngest client (serverEnv at load); stub it.
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));

import { generateAndStoreInsights } from "@/lib/lesson-notes/insights-pipeline";
import {
  InsightsUnavailableError,
  writesEnglishInsights,
  type Insight,
  type InsightsInput,
} from "@/lib/lesson-notes/insights";
import { strings } from "@spiralclass/shared";

const BOOKING = "booking-1";
const TEACHER = "teacher-1";

function makeDb(
  opts: {
    transcript?: { utterances: unknown; language: string; teacherId: string } | null;
    booking?: boolean;
    teacher?: { locale: string; targetLanguage: string | null };
    lessonNotes?: { audience: string; body: string; doneAt: Date | null }[];
    pronunciation?: { scores: unknown } | null;
  } = {},
) {
  const deleted: any[] = [];
  const created: any[] = [];
  const db = {
    lessonTranscript: {
      findUnique: vi.fn(async () =>
        opts.transcript === undefined
          ? {
              utterances: [{ speaker: "student", text: "Yo es feliz", startMs: 1000 }],
              language: "es",
              teacherId: TEACHER,
            }
          : opts.transcript,
      ),
    },
    booking: {
      findUnique: vi.fn(async () =>
        opts.booking === false
          ? null
          : {
              teacherId: TEACHER,
              student: { name: "Mira" },
              teacher: opts.teacher ?? { locale: "en", targetLanguage: "es" },
              lessonNotes: opts.lessonNotes ?? [
                { audience: "teacher", body: "ser vs estar", doneAt: new Date() },
              ],
            },
      ),
    },
    lessonInsight: {
      deleteMany: vi.fn(async (args: any) => {
        deleted.push(args.where);
        return { count: 0 };
      }),
      createMany: vi.fn(async (args: any) => {
        created.push(...args.data);
        return { count: args.data.length };
      }),
    },
    lessonPronunciation: {
      findUnique: vi.fn(async () => opts.pronunciation ?? null),
    },
  };
  return { db, deleted, created };
}

const oneInsight: Insight[] = [
  {
    category: "grammar",
    summary: "ser/estar",
    evidence: "Yo es feliz",
    suggestion: "Yo estoy feliz",
    atMs: 1000,
  },
];

function deps(db: any, generate: any) {
  return { prisma: db, generate, inngest: { send: vi.fn(async () => ({}) as any) } };
}

beforeEach(() => vi.clearAllMocks());

describe("generateAndStoreInsights", () => {
  it("generates, replaces AI rows, and fires lesson.insights.ready", async () => {
    const { db, deleted, created } = makeDb();
    const generate = vi.fn(async () => oneInsight);
    const d = deps(db, generate);

    const out = await generateAndStoreInsights(d, BOOKING);

    expect(out).toEqual({ code: "generated", count: 1 });
    // Idempotent replace: deletes only AI, not-yet-confirmed rows first.
    expect(deleted[0]).toEqual({ bookingId: BOOKING, source: "ai", confirmedAt: null });
    expect(created[0]).toMatchObject({
      bookingId: BOOKING,
      teacherId: TEACHER,
      category: "grammar",
      source: "ai",
    });
    expect(d.inngest.send).toHaveBeenCalledWith({
      name: "lesson.insights.ready",
      data: { bookingId: BOOKING, teacherId: TEACHER, count: 1 },
    });
  });

  it("passes the teacher's locale through (en/es) and the transcript utterances", async () => {
    const { db } = makeDb();
    const generate = vi.fn(async (_input: InsightsInput) => oneInsight);
    await generateAndStoreInsights(deps(db, generate), BOOKING);
    const arg = generate.mock.calls[0][0];
    expect(arg.en).toBe(true);
    expect(arg.studentName).toBe("Mira");
    expect(arg.utterances).toEqual([{ speaker: "student", text: "Yo es feliz", atMs: 1000 }]);
    expect(arg.teacherCues).toEqual([{ body: "ser vs estar", done: true }]);
  });

  it("feeds Phase D pronunciation weak words into the generator when scored (audio-grounded)", async () => {
    const { db } = makeDb({
      pronunciation: {
        scores: {
          overall: { pron: 70 },
          weakWords: [
            {
              word: "subjuntivo",
              accuracy: 40,
              atMs: 1200,
              phonemes: [{ phoneme: "x", accuracy: 30 }],
            },
          ],
        },
      },
    });
    const generate = vi.fn(async (_input: InsightsInput) => oneInsight);
    await generateAndStoreInsights(deps(db, generate), BOOKING);
    const arg = generate.mock.calls[0][0];
    expect(arg.pronunciation).toEqual({
      weakWords: [
        {
          word: "subjuntivo",
          accuracy: 40,
          atMs: 1200,
          phonemes: [{ phoneme: "x", accuracy: 30 }],
        },
      ],
    });
  });

  it("passes no pronunciation when none was scored", async () => {
    const { db } = makeDb({ pronunciation: null });
    const generate = vi.fn(async (_input: InsightsInput) => oneInsight);
    await generateAndStoreInsights(deps(db, generate), BOOKING);
    expect(generate.mock.calls[0][0].pronunciation).toBeUndefined();
  });

  it("skips when there is no transcript", async () => {
    const { db } = makeDb({ transcript: null });
    const generate = vi.fn();
    const out = await generateAndStoreInsights(deps(db, generate), BOOKING);
    expect(out).toEqual({ code: "skipped", reason: "no-transcript" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("skips with no rows when Anthropic is unavailable (degrade gracefully)", async () => {
    const { db, created } = makeDb();
    const generate = vi.fn(async () => {
      throw new InsightsUnavailableError("no key");
    });
    const out = await generateAndStoreInsights(deps(db, generate), BOOKING);
    expect(out).toEqual({ code: "skipped", reason: "ai-unavailable" });
    expect(created).toHaveLength(0);
  });

  it("skips when there's no signal at all (empty transcript + no notes)", async () => {
    const { db } = makeDb({
      transcript: { utterances: [], language: "es", teacherId: TEACHER },
      lessonNotes: [],
    });
    const generate = vi.fn();
    const out = await generateAndStoreInsights(deps(db, generate), BOOKING);
    expect(out).toEqual({ code: "skipped", reason: "no-signal" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("replaces with zero rows when the model returns nothing (still clears stale)", async () => {
    const { db, deleted, created } = makeDb();
    const generate = vi.fn(async () => []);
    const out = await generateAndStoreInsights(deps(db, generate), BOOKING);
    expect(out).toEqual({ code: "generated", count: 0 });
    expect(deleted[0]).toEqual({ bookingId: BOOKING, source: "ai", confirmedAt: null });
    expect(created).toHaveLength(0); // nothing inserted, but stale AI rows cleared
  });
});

describe("the language the model is told to grade against", () => {
  // transcript.language is the ASR tag, and transcription/pipeline.ts hardcodes
  // it to DEFAULT_LESSON_LANGUAGE ("es") for every capture. Reading it here told
  // the model that every lesson on a subject-agnostic platform was Spanish.
  it("comes from the teacher's own subject, not the ASR tag", async () => {
    const { db } = makeDb({ teacher: { locale: "en", targetLanguage: "fr" } });
    const generate = vi.fn(async () => oneInsight);
    await generateAndStoreInsights(deps(db, generate), BOOKING);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: "fr" }));
  });

  it("falls back to the transcript tag when she has not set a subject", async () => {
    const { db } = makeDb({ teacher: { locale: "en", targetLanguage: null } });
    const generate = vi.fn(async () => oneInsight);
    await generateAndStoreInsights(deps(db, generate), BOOKING);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: "es" }));
  });

  // Her `locale` is what she READS; targetLanguage is what she TEACHES. Both
  // feed the same prompt and they are allowed to diverge (D-72/D-73) — this is
  // the teacher of Spanish who reads the dashboard in English.
  it("keeps the reading language independent of the subject", async () => {
    const { db } = makeDb({ teacher: { locale: "es-MX", targetLanguage: "en" } });
    const generate = vi.fn(async () => oneInsight);
    await generateAndStoreInsights(deps(db, generate), BOOKING);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ targetLanguage: "en", en: false }),
    );
  });
});

describe("which language the findings are written in", () => {
  // The prompt exists in English and Spanish only, so the rule has to be "is
  // she a Spanish reader", not "is she an English reader". Those agree while
  // there are two locales and diverge the moment a third appears — and the
  // catalog already ships fr.
  it.each([
    ["en", true],
    ["es-MX", false],
    ["fr", true],
  ])("locale %s -> English findings: %s", async (locale, english) => {
    const { db } = makeDb({ teacher: { locale: locale as string, targetLanguage: "es" } });
    const generate = vi.fn(async () => oneInsight);
    await generateAndStoreInsights(deps(db, generate), BOOKING);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ en: english }));
  });

  it("never routes an unrecognised locale into the Spanish prompt", () => {
    // The regression, stated as the invariant: only the one locale that has a
    // translated prompt may take the non-default branch. Everything else —
    // including a locale added to the catalog years from now, by someone not
    // reading this file — falls back to DEFAULT_LOCALE's language.
    for (const locale of Object.keys(strings)) {
      if (locale === "es-MX") continue;
      expect(writesEnglishInsights(locale)).toBe(true);
    }
    expect(writesEnglishInsights("pt-BR")).toBe(true);
  });
});
