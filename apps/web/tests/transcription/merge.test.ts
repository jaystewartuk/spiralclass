import { describe, expect, it } from "vitest";
import { mergeSpeakerSegment, normalizeTimeline } from "@/lib/transcription/merge";
import type { SpeakerUtterance, TranscriptionResult } from "@/lib/transcription/types";

// The two per-speaker files merge onto one booking timeline. Each file's times
// are relative to its own egress start, so the merge offsets by egress start
// (epoch ms); normalizeTimeline rebases the finished transcript to 0.

function result(texts: { text: string; startMs: number; endMs: number }[]): TranscriptionResult {
  return {
    provider: "deepgram",
    utterances: texts.map((t) => ({ ...t, words: [] })),
  };
}

describe("mergeSpeakerSegment", () => {
  it("offsets each file by its egress start and orders by absolute startMs", () => {
    // Teacher egress started 10s before the student egress.
    const teacher = mergeSpeakerSegment([], {
      speaker: "teacher",
      egressStartMs: 1_000_000,
      result: result([{ text: "Hello", startMs: 0, endMs: 500 }]),
    });
    const both = mergeSpeakerSegment(teacher, {
      speaker: "student",
      egressStartMs: 1_010_000,
      result: result([{ text: "Hola", startMs: 0, endMs: 400 }]),
    });

    expect(both.map((u) => ({ speaker: u.speaker, startMs: u.startMs }))).toEqual([
      { speaker: "teacher", startMs: 1_000_000 },
      { speaker: "student", startMs: 1_010_000 },
    ]);
  });

  it("replaces a speaker's prior utterances when its file is reprocessed", () => {
    const v1 = mergeSpeakerSegment([], {
      speaker: "student",
      egressStartMs: 0,
      result: result([{ text: "old", startMs: 0, endMs: 100 }]),
    });
    const v2 = mergeSpeakerSegment(v1, {
      speaker: "student",
      egressStartMs: 0,
      result: result([{ text: "new", startMs: 0, endMs: 100 }]),
    });
    expect(v2).toHaveLength(1);
    expect(v2[0].text).toBe("new");
  });

  it("shifts word timestamps along with the utterance", () => {
    const merged = mergeSpeakerSegment([], {
      speaker: "teacher",
      egressStartMs: 5_000,
      result: {
        provider: "deepgram",
        utterances: [
          {
            text: "hi",
            startMs: 100,
            endMs: 300,
            words: [{ text: "hi", startMs: 100, endMs: 300, confidence: 1 }],
          },
        ],
      },
    });
    expect(merged[0].startMs).toBe(5_100);
    expect(merged[0].words[0]).toMatchObject({ startMs: 5_100, endMs: 5_300 });
  });
});

describe("normalizeTimeline", () => {
  it("rebases so the earliest utterance starts at 0, preserving gaps", () => {
    const utterances: SpeakerUtterance[] = [
      {
        speaker: "teacher",
        text: "a",
        startMs: 1_000_000,
        endMs: 1_000_500,
        words: [{ text: "a", startMs: 1_000_000, endMs: 1_000_500, confidence: 1 }],
      },
      { speaker: "student", text: "b", startMs: 1_010_000, endMs: 1_010_400, words: [] },
    ];
    const normalized = normalizeTimeline(utterances);
    expect(normalized[0].startMs).toBe(0);
    expect(normalized[0].words[0].startMs).toBe(0);
    expect(normalized[1].startMs).toBe(10_000);
  });

  it("no-ops on empty", () => {
    expect(normalizeTimeline([])).toEqual([]);
  });
});
