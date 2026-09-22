import { describe, expect, it } from "vitest";
import {
  lessonNoteStudentVisible,
  NOTE_VISIBLE_AFTER_MIN,
  NOTE_VISIBLE_BEFORE_MIN,
} from "@/lib/lesson-notes/visibility";

// D-12 — the student panel opens NOTE_VISIBLE_BEFORE_MIN before the class and
// closes NOTE_VISIBLE_AFTER_MIN after it ends. Single source of truth for the
// gated student read paths.

const START = new Date("2026-06-12T15:00:00Z");
const END = new Date("2026-06-12T15:50:00Z"); // 50-min class
const minutesFrom = (anchor: Date, m: number) => new Date(anchor.getTime() + m * 60_000);

describe("lessonNoteStudentVisible", () => {
  it("hidden well before the window opens", () => {
    expect(lessonNoteStudentVisible(START, END, minutesFrom(START, -60))).toBe(false);
  });

  it("opens exactly NOTE_VISIBLE_BEFORE_MIN before start (boundary inclusive)", () => {
    expect(lessonNoteStudentVisible(START, END, minutesFrom(START, -NOTE_VISIBLE_BEFORE_MIN))).toBe(
      true,
    );
  });

  it("still hidden one minute before the window opens", () => {
    expect(
      lessonNoteStudentVisible(START, END, minutesFrom(START, -(NOTE_VISIBLE_BEFORE_MIN + 1))),
    ).toBe(false);
  });

  it("visible during the class", () => {
    expect(lessonNoteStudentVisible(START, END, minutesFrom(START, 25))).toBe(true);
  });

  it("closes exactly NOTE_VISIBLE_AFTER_MIN after end (boundary inclusive)", () => {
    expect(lessonNoteStudentVisible(START, END, minutesFrom(END, NOTE_VISIBLE_AFTER_MIN))).toBe(
      true,
    );
  });

  it("hidden once the after-window has passed", () => {
    expect(lessonNoteStudentVisible(START, END, minutesFrom(END, NOTE_VISIBLE_AFTER_MIN + 1))).toBe(
      false,
    );
  });
});
