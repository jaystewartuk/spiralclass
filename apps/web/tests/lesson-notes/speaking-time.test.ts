import { describe, expect, it } from "vitest";
import { computeSpeakingTime } from "@/lib/lesson-notes/speaking-time";
import type { SpeakerUtterance } from "@/lib/transcription/types";

function utt(speaker: "teacher" | "student", startMs: number, endMs: number): SpeakerUtterance {
  return { speaker, text: "x", startMs, endMs, words: [] };
}

describe("computeSpeakingTime", () => {
  it("returns null when there's neither an audio duration nor an utterance to anchor a total", () => {
    expect(computeSpeakingTime([], [])).toBeNull();
    expect(computeSpeakingTime([{ durationMs: null }], [])).toBeNull();
  });

  // D-189: a transcript the browsers wrote has no LessonAudio row, so the last
  // line's end anchors the lesson's length instead.
  it("anchors the total on the last utterance when there is no audio row", () => {
    const summary = computeSpeakingTime(
      [],
      [utt("teacher", 0, 20_000), utt("student", 30_000, 50_000)],
    );
    expect(summary).toEqual({
      totalMs: 50_000,
      teacherSpeakingMs: 20_000,
      studentSpeakingMs: 20_000,
      teacherSharePct: 40,
      studentSharePct: 40,
    });
  });

  it("prefers the audio duration when it is longer, since it counts the trailing silence", () => {
    expect(
      computeSpeakingTime([{ durationMs: 90_000 }], [utt("teacher", 0, 20_000)])?.totalMs,
    ).toBe(90_000);
  });

  it("sums per-speaker utterance durations and shares them against the lesson total", () => {
    const summary = computeSpeakingTime(
      [{ durationMs: 100_000 }, { durationMs: 100_000 }],
      [utt("teacher", 0, 20_000), utt("student", 20_000, 60_000), utt("teacher", 60_000, 70_000)],
    );
    expect(summary).toEqual({
      totalMs: 100_000,
      teacherSpeakingMs: 30_000,
      studentSpeakingMs: 40_000,
      teacherSharePct: 30,
      studentSharePct: 40,
    });
  });

  it("takes the max durationMs across speaker audio files as the lesson total", () => {
    const summary = computeSpeakingTime([{ durationMs: 50_000 }, { durationMs: 80_000 }], []);
    expect(summary?.totalMs).toBe(80_000);
  });

  it("clamps a speaker's speaking time to the lesson total", () => {
    // Two overlapping utterances (an ASR quirk) would otherwise sum past the
    // lesson's own length.
    const summary = computeSpeakingTime(
      [{ durationMs: 10_000 }],
      [utt("teacher", 0, 10_000), utt("teacher", 2_000, 10_000)],
    );
    expect(summary?.teacherSpeakingMs).toBe(10_000);
    expect(summary?.teacherSharePct).toBe(100);
  });

  it("ignores a negative-duration utterance rather than subtracting", () => {
    const summary = computeSpeakingTime([{ durationMs: 10_000 }], [utt("student", 5_000, 1_000)]);
    expect(summary?.studentSpeakingMs).toBe(0);
  });
});
