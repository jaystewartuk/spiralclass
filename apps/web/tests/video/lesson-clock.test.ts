import { describe, expect, it } from "vitest";
import { lessonClock } from "@/lib/video/lesson-clock";

const START = Date.parse("2026-10-02T19:00:00Z");
const END = Date.parse("2026-10-02T19:50:00Z");
const at = (iso: string) => lessonClock(Date.parse(iso), START, END);

describe("lessonClock", () => {
  it("counts down to the start, rounding up", () => {
    expect(at("2026-10-02T18:57:30Z")).toEqual({ phase: "before", minutes: 3, warn: false });
    expect(at("2026-10-02T18:59:59Z")).toEqual({ phase: "before", minutes: 1, warn: false });
  });

  it("counts what is left of the class, never reaching 0 while it runs", () => {
    expect(at("2026-10-02T19:00:00Z")).toEqual({ phase: "during", minutes: 50, warn: false });
    expect(at("2026-10-02T19:27:10Z")).toEqual({ phase: "during", minutes: 23, warn: false });
    expect(at("2026-10-02T19:49:59Z")).toEqual({ phase: "during", minutes: 1, warn: true });
  });

  it("warns in the last five minutes, not the sixth", () => {
    expect(at("2026-10-02T19:44:00Z").warn).toBe(false);
    expect(at("2026-10-02T19:45:00Z")).toEqual({ phase: "during", minutes: 5, warn: true });
  });

  it("counts the overrun from its first second", () => {
    expect(at("2026-10-02T19:50:00Z")).toEqual({ phase: "over", minutes: 1, warn: true });
    expect(at("2026-10-02T19:53:20Z")).toEqual({ phase: "over", minutes: 4, warn: true });
  });
});
