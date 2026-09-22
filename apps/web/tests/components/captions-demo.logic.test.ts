import { describe, expect, it } from "vitest";
import { CAPTION_LINES } from "@/components/marketing/captions-demo.data";
import {
  revealTimeline,
  totalDurationMs,
  visibleCountAt,
} from "@/components/marketing/captions-demo.logic";

// The marketing live-captions demo streams canned lines on timers. The
// sequencing is a pure helper (captions-demo.logic.ts) so it's testable without
// fake timers or a DOM — this pins reveal ordering and the reduced-motion
// "show everything at once" boundary the client component relies on.

describe("revealTimeline", () => {
  it("accumulates per-line relative delays into strictly increasing absolute times", () => {
    const timeline = revealTimeline([
      { es: "a", en: "a", delayMs: 500 },
      { es: "b", en: "b", delayMs: 2000 },
      { es: "c", en: "c", delayMs: 1000 },
    ]);
    expect(timeline).toEqual([500, 2500, 3500]);
  });

  it("returns an empty timeline for no lines", () => {
    expect(revealTimeline([])).toEqual([]);
  });
});

describe("visibleCountAt", () => {
  const lines = CAPTION_LINES;

  it("shows nothing before the first line's delay elapses", () => {
    expect(visibleCountAt(0, lines)).toBe(0);
  });

  it("reveals lines cumulatively as elapsed time passes each threshold", () => {
    const timeline = revealTimeline(lines);
    expect(visibleCountAt(timeline[0], lines)).toBe(1);
    expect(visibleCountAt(timeline[0] - 1, lines)).toBe(0);
    expect(visibleCountAt(timeline[1], lines)).toBe(2);
  });

  it("shows the full transcript once total duration has elapsed (the reduced-motion 'show all' state)", () => {
    expect(visibleCountAt(totalDurationMs(lines), lines)).toBe(lines.length);
    expect(visibleCountAt(Number.MAX_SAFE_INTEGER, lines)).toBe(lines.length);
  });
});

describe("captions demo data", () => {
  it("pairs every Spanish line with a non-empty English translation and a positive delay", () => {
    expect(CAPTION_LINES.length).toBeGreaterThan(0);
    for (const line of CAPTION_LINES) {
      expect(line.es.trim().length).toBeGreaterThan(0);
      expect(line.en.trim().length).toBeGreaterThan(0);
      expect(line.delayMs).toBeGreaterThan(0);
    }
  });
});
