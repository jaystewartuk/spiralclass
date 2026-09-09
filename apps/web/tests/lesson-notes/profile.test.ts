import { describe, expect, it } from "vitest";
import {
  aggregateSpeakingBalance,
  computeProfile,
  type ProfileInsight,
} from "@/lib/lesson-notes/profile";
import type { SpeakingTimeSummary } from "@/lib/lesson-notes/speaking-time";

// computeProfile is the substance of Phase E — recurrence + trend across lessons.
// Three lessons; the recent window is the last 2 (L2, L3).
const L1 = new Date("2026-06-01T15:00:00Z");
const L2 = new Date("2026-06-08T15:00:00Z");
const L3 = new Date("2026-06-15T15:00:00Z");
const LESSONS = [L1, L2, L3];

function ins(over: Partial<ProfileInsight>): ProfileInsight {
  return {
    category: "grammar",
    skill: "ser_vs_estar",
    summary: "ser/estar",
    evidence: null,
    lessonAt: L1,
    ...over,
  };
}

describe("computeProfile", () => {
  it("counts recurrence and takes first/last seen + latest evidence", () => {
    const profile = computeProfile(
      [
        ins({ lessonAt: L1, evidence: "yo es feliz" }),
        ins({ lessonAt: L2, evidence: "ella es cansada" }),
        ins({ lessonAt: L3, evidence: "estoy contento" }),
      ],
      LESSONS,
    );
    const entry = profile.byCategory.grammar!.ser_vs_estar!;
    expect(entry.recurrenceCount).toBe(3);
    expect(entry.firstSeenAt).toBe(L1.toISOString());
    expect(entry.lastSeenAt).toBe(L3.toISOString());
    expect(entry.lastEvidence).toBe("estoy contento");
    expect(entry.trend).toBe("focus"); // recurring + present in recent lessons
  });

  it("marks a skill absent from the recent window as improving", () => {
    const profile = computeProfile(
      [ins({ skill: "subjunctive", summary: "subjuntivo", lessonAt: L1 })],
      LESSONS,
    );
    expect(profile.byCategory.grammar!.subjunctive!.trend).toBe("improving");
  });

  it("marks a single recent occurrence as new", () => {
    const profile = computeProfile(
      [ins({ skill: "por_vs_para", summary: "por/para", lessonAt: L3 })],
      LESSONS,
    );
    expect(profile.byCategory.grammar!.por_vs_para!.trend).toBe("new");
  });

  it("groups by category+skill, falling back to a normalised summary when skill is null", () => {
    const profile = computeProfile(
      [
        ins({
          skill: null,
          summary: "Drops final s sounds",
          category: "pronunciation",
          lessonAt: L2,
        }),
        ins({
          skill: null,
          summary: "Drops final s sounds",
          category: "pronunciation",
          lessonAt: L3,
        }),
      ],
      LESSONS,
    );
    const skills = Object.keys(profile.byCategory.pronunciation!);
    expect(skills).toHaveLength(1);
    expect(profile.byCategory.pronunciation![skills[0]!]!.recurrenceCount).toBe(2);
  });

  it("accumulates a deduped vocabulary queue, newest first", () => {
    const profile = computeProfile(
      [
        ins({ category: "vocabulary", skill: "theme", summary: "la sobremesa", lessonAt: L1 }),
        ins({ category: "vocabulary", skill: "theme", summary: "la sobremesa", lessonAt: L2 }), // dup
        ins({ category: "vocabulary", skill: "theme", summary: "el madrugón", lessonAt: L3 }),
      ],
      LESSONS,
    );
    // 'la sobremesa' deduped (kept once, last seen L2); newest sighting first.
    expect(profile.vocabulary.map((v) => v.term)).toEqual(["el madrugón", "la sobremesa"]);
  });

  it("returns an empty profile for no insights", () => {
    expect(computeProfile([], LESSONS)).toEqual({
      byCategory: {},
      vocabulary: [],
      speakingBalance: null,
    });
  });

  it("passes speakingBalance through unchanged (D-97)", () => {
    const balance = { teacherSharePct: 40, studentSharePct: 55, lessonsCounted: 3 };
    const profile = computeProfile([], LESSONS, balance);
    expect(profile.speakingBalance).toEqual(balance);
  });
});

describe("aggregateSpeakingBalance", () => {
  function summary(over: Partial<SpeakingTimeSummary>): SpeakingTimeSummary {
    return {
      totalMs: 60_000,
      teacherSpeakingMs: 0,
      studentSpeakingMs: 0,
      teacherSharePct: 0,
      studentSharePct: 0,
      ...over,
    };
  }

  it("returns null with no lessons", () => {
    expect(aggregateSpeakingBalance([])).toBeNull();
  });

  it("averages shares across lessons and counts them", () => {
    const result = aggregateSpeakingBalance([
      summary({ teacherSharePct: 60, studentSharePct: 20 }),
      summary({ teacherSharePct: 40, studentSharePct: 40 }),
    ]);
    expect(result).toEqual({ teacherSharePct: 50, studentSharePct: 30, lessonsCounted: 2 });
  });
});
