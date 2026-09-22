import type { PrismaClient } from "@prisma/client";

import { isPronunciationLanguageSupported, pronunciationEnabled } from "./config";
import { getPronunciationProvider, type PronunciationProvider } from "./provider";
import type { PronunciationResult, StoredPronunciation, WeakWord } from "./types";

// Phase D scoring core. Folds into
// the Phase B pipeline: given the student audio URL + its just-produced
// transcript as reference, score pronunciation and upsert the booking's
// LessonPronunciation row — while the audio is still present, before the
// derive-then-discard step. Side effects are injected so this is unit-testable.

// A word below this accuracy is "weak" and worth surfacing.
export const WEAK_WORD_ACCURACY_THRESHOLD = 60;
// Keep the surfaced set small (and the stored JSON bounded).
export const MAX_WEAK_WORDS = 12;

// Condense a full assessment to what we store/feed Phase C: the overall plus the
// weakest words (worst first), capped.
export function toStoredPronunciation(result: PronunciationResult): StoredPronunciation {
  const weakWords: WeakWord[] = result.words
    .filter((w) => w.word && w.accuracy < WEAK_WORD_ACCURACY_THRESHOLD)
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, MAX_WEAK_WORDS)
    .map((w) => ({
      word: w.word,
      accuracy: w.accuracy,
      atMs: w.startMs,
      ...(w.phonemes && w.phonemes.length ? { phonemes: w.phonemes } : {}),
    }));
  return { overall: result.overall, weakWords };
}

type Db = Pick<PrismaClient, "lessonPronunciation">;

export type ScoreArgs = {
  bookingId: string;
  teacherId: string;
  audioUrl: string;
  referenceText: string;
  language: string;
};

export type ScoreDeps = {
  enabled: () => boolean;
  isSupported: (language: string) => boolean;
  getProvider: () => PronunciationProvider | null;
};

const defaultDeps: ScoreDeps = {
  enabled: pronunciationEnabled,
  isSupported: isPronunciationLanguageSupported,
  getProvider: getPronunciationProvider,
};

export type ScoreOutcome =
  { code: "skipped"; reason: string } | { code: "scored"; weakWords: number };

// Score the student audio and upsert the booking's pronunciation row. Dormant
// unless enabled + a vendor is configured + the language is supported. Never
// throws on a skip; lets a real provider/SDK error propagate to the caller (the
// pipeline wraps this best-effort so a failure can't block transcription/discard).
export async function scoreAndStorePronunciation(
  prisma: Db,
  args: ScoreArgs,
  deps: ScoreDeps = defaultDeps,
): Promise<ScoreOutcome> {
  if (!deps.enabled()) return { code: "skipped", reason: "disabled" };
  if (!deps.isSupported(args.language)) return { code: "skipped", reason: "language-unsupported" };
  if (!args.referenceText.trim()) return { code: "skipped", reason: "no-reference-text" };

  const provider = deps.getProvider();
  if (!provider) return { code: "skipped", reason: "no-provider" };

  const result = await provider.score({
    audioUrl: args.audioUrl,
    referenceText: args.referenceText,
    language: args.language,
  });
  const scores = toStoredPronunciation(result);

  await prisma.lessonPronunciation.upsert({
    where: { bookingId: args.bookingId },
    create: {
      bookingId: args.bookingId,
      teacherId: args.teacherId,
      language: args.language,
      scores: scores as unknown as object,
      provider: result.provider,
    },
    update: {
      scores: scores as unknown as object,
      provider: result.provider,
      language: args.language,
    },
  });

  return { code: "scored", weakWords: scores.weakWords.length };
}
