import type { CaptionLine } from "./captions-demo.data";

// Pure sequencing helpers for the live-captions demo, split out from the client
// component so the streaming logic is unit-testable without fake timers or a DOM.

// Cumulative appearance time (ms from start) for each line, derived from the
// per-line relative delays.
export function revealTimeline(lines: CaptionLine[]): number[] {
  const times: number[] = [];
  let acc = 0;
  for (const line of lines) {
    acc += line.delayMs;
    times.push(acc);
  }
  return times;
}

// How many lines should be visible at a given elapsed time.
export function visibleCountAt(elapsedMs: number, lines: CaptionLine[]): number {
  return revealTimeline(lines).filter((t) => t <= elapsedMs).length;
}

// Total run length of the sequence (ms) — i.e. when the last line has appeared.
export function totalDurationMs(lines: CaptionLine[]): number {
  const timeline = revealTimeline(lines);
  return timeline.length ? timeline[timeline.length - 1] : 0;
}
