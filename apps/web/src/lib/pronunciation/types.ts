// Shared pronunciation types (lesson-insights Phase D,
// the Phase D design). Vendor-agnostic shapes the
// PronunciationProvider seam returns and the store/Phase-C feed consume. Scores
// are 0–100; times are integer ms relative to the audio file.

export type PronunciationOverall = {
  accuracy: number;
  fluency: number;
  completeness: number;
  pron: number; // Azure's combined "pronunciation score"
};

export type ScoredPhoneme = { phoneme: string; accuracy: number };

export type ScoredWord = {
  word: string;
  accuracy: number;
  startMs: number;
  endMs: number;
  phonemes?: ScoredPhoneme[];
};

// One vendor's full assessment of one audio file.
export type PronunciationResult = {
  overall: PronunciationOverall;
  words: ScoredWord[];
  provider: string;
};

// The condensed form stored on LessonPronunciation.scores and fed to Phase C:
// just the overall plus the weak words worth surfacing.
export type WeakWord = {
  word: string;
  accuracy: number;
  atMs: number;
  phonemes?: ScoredPhoneme[];
};

export type StoredPronunciation = {
  overall: PronunciationOverall;
  weakWords: WeakWord[];
};
