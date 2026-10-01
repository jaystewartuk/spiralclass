// The lesson clock in the call's top bar: how long until the class starts,
// how much of it is left, or how far past its end it has run. A teacher in a
// 50-minute lesson had no clock on the call screen at all, and the one she
// would otherwise glance at is the phone she is teaching from.
//
// Whole minutes, rounded the way a person reads a clock: "1 min left" until
// the last second of the class, never "0 min left"; "1 min over" from its
// first second past the end. `warn` is the last five minutes and any overrun,
// when wrapping up is the thing to be thinking about.
export type LessonClock =
  | { phase: "before"; minutes: number; warn: false }
  | { phase: "during"; minutes: number; warn: boolean }
  | { phase: "over"; minutes: number; warn: true };

export const LESSON_CLOCK_WARN_MINUTES = 5;

const MINUTE_MS = 60_000;

export function lessonClock(nowMs: number, startMs: number, endMs: number): LessonClock {
  if (nowMs < startMs) {
    return { phase: "before", minutes: Math.ceil((startMs - nowMs) / MINUTE_MS), warn: false };
  }
  if (nowMs < endMs) {
    const minutes = Math.ceil((endMs - nowMs) / MINUTE_MS);
    return { phase: "during", minutes, warn: minutes <= LESSON_CLOCK_WARN_MINUTES };
  }
  return {
    phase: "over",
    minutes: Math.max(1, Math.ceil((nowMs - endMs) / MINUTE_MS)),
    warn: true,
  };
}
