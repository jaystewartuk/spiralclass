import { describe, expect, it, vi } from "vitest";
import {
  scheduleNext,
  seedVocabularyReviews,
  MIN_EASE,
  DEFAULT_EASE,
} from "@/lib/lesson-notes/srs";

const NOW = new Date("2026-06-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("scheduleNext", () => {
  it("first successful review: good→1d, easy→4d, hard→1d", () => {
    const base = { intervalDays: 0, easeFactor: DEFAULT_EASE };
    expect(scheduleNext(base, "good", NOW).intervalDays).toBe(1);
    expect(scheduleNext(base, "easy", NOW).intervalDays).toBe(4);
    expect(scheduleNext(base, "hard", NOW).intervalDays).toBe(1);
  });

  it("second review (interval 1): good→6d, hard stays 1d", () => {
    expect(
      scheduleNext({ intervalDays: 1, easeFactor: DEFAULT_EASE }, "good", NOW).intervalDays,
    ).toBe(6);
    expect(
      scheduleNext({ intervalDays: 1, easeFactor: DEFAULT_EASE }, "hard", NOW).intervalDays,
    ).toBe(1);
  });

  it("subsequent reviews multiply by ease (good) or 1.2 (hard)", () => {
    expect(scheduleNext({ intervalDays: 6, easeFactor: 2.5 }, "good", NOW).intervalDays).toBe(15); // 6*2.5
    expect(scheduleNext({ intervalDays: 6, easeFactor: 2.5 }, "hard", NOW).intervalDays).toBe(7); // round(6*1.2)
  });

  it("'again' resets the interval and re-shows the term within ~10 minutes", () => {
    const next = scheduleNext({ intervalDays: 15, easeFactor: 2.5 }, "again", NOW);
    expect(next.intervalDays).toBe(0);
    expect(next.dueAt.getTime()).toBe(NOW.getTime() + 10 * 60 * 1000);
    expect(next.easeFactor).toBeLessThan(2.5); // penalised
  });

  it("ease grows on easy, shrinks on hard, and floors at MIN_EASE", () => {
    expect(scheduleNext({ intervalDays: 6, easeFactor: 2.5 }, "easy", NOW).easeFactor).toBeCloseTo(
      2.6,
      5,
    );
    expect(scheduleNext({ intervalDays: 6, easeFactor: 2.5 }, "hard", NOW).easeFactor).toBeCloseTo(
      2.36,
      5,
    );
    // Repeated 'again' from a low ease can't go below the floor.
    expect(scheduleNext({ intervalDays: 0, easeFactor: 1.3 }, "again", NOW).easeFactor).toBe(
      MIN_EASE,
    );
  });

  it("computes dueAt as now + intervalDays for a graded term", () => {
    const next = scheduleNext({ intervalDays: 0, easeFactor: DEFAULT_EASE }, "good", NOW);
    expect(next.dueAt.getTime()).toBe(NOW.getTime() + 1 * DAY);
  });
});

describe("seedVocabularyReviews", () => {
  function makeDb() {
    const createMany = vi.fn(async (args: any) => ({ count: args.data.length }));
    return { db: { vocabularyReview: { createMany } }, createMany };
  }

  it("seeds new terms due-now with skipDuplicates, deduping + trimming", async () => {
    const { db, createMany } = makeDb();
    const count = await seedVocabularyReviews(db as any, {
      teacherId: "t1",
      studentId: "s1",
      terms: ["la sobremesa", " la sobremesa ", "el madrugón", "  "],
      now: NOW,
    });
    expect(createMany).toHaveBeenCalledTimes(1);
    const arg = createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toEqual([
      { teacherId: "t1", studentId: "s1", term: "la sobremesa", dueAt: NOW },
      { teacherId: "t1", studentId: "s1", term: "el madrugón", dueAt: NOW },
    ]);
    expect(count).toBe(2);
  });

  it("no-ops on an empty queue", async () => {
    const { db, createMany } = makeDb();
    const count = await seedVocabularyReviews(db as any, {
      teacherId: "t1",
      studentId: "s1",
      terms: ["  "],
      now: NOW,
    });
    expect(createMany).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});
