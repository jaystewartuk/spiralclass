// Shared transcription types (lesson-insights Phase B,
// the Phase B design). Vendor-agnostic shapes the
// TranscriptionProvider seam returns and the merge layer consumes. All times are
// integer milliseconds relative to the START OF THE AUDIO FILE — the merge layer
// offsets them onto a single booking timeline.

export type Word = {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
};

export type Utterance = {
  text: string;
  startMs: number;
  endMs: number;
  words: Word[];
};

// One vendor's transcript of ONE audio file (a single known speaker).
export type TranscriptionResult = {
  utterances: Utterance[];
  provider: string;
};

export type Speaker = "student" | "teacher";

// An utterance after merge: tagged with the (known) speaker and shifted onto the
// booking-wide timeline. This is the shape stored in LessonTranscript.utterances.
export type SpeakerUtterance = Utterance & { speaker: Speaker };
