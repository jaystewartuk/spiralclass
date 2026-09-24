import { isValidYmd } from "@/lib/calendar-grid";

/**
 * The decisions the day plan (/dashboard/classes/plan) makes before it renders.
 *
 * The page is a teacher's planning notebook laid out the way she already keeps
 * it on paper: one page per day, one section per student, a few bullets of what
 * she means to cover. It is a view over existing data — each bullet is a
 * private teacher cue (`LessonNote`, audience "teacher") on that class — so the
 * plan she writes here is the same list she ticks off during the call and the
 * one "copy from last class" carries forward. See
 * docs/features/classes-lesson-content.md.
 *
 * Kept pure so it is unit-testable; the page owns the queries and the markup.
 */

export const DAY_PLAN_PATH = "/dashboard/classes/plan";

/**
 * A `?d=` value from the URL, narrowed to a real calendar day. Anything else —
 * absent, malformed, or calendar-impossible ("2026-02-30") — falls back to the
 * teacher's today rather than 404ing: it is a view preference, and a stale or
 * hand-edited link should still show her a plan.
 */
export function resolvePlanDay(raw: string | string[] | undefined, todayYmd: string): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && isValidYmd(value) ? value : todayYmd;
}

/** The canonical URL for one day's plan. Today is the bare path. */
export function dayPlanHref(ymd: string, todayYmd: string): string {
  return ymd === todayYmd ? DAY_PLAN_PATH : `${DAY_PLAN_PATH}?d=${ymd}`;
}

/**
 * Whether this class is the last one its package pays for — the moment a
 * teacher wants to raise renewal, and the note she writes against a student's
 * name in her notebook ("última clase").
 *
 * Under Model B `classesUsed` counts every committed class, reserved or taught,
 * so the package is spent once `classesUsed` reaches `classesTotal`. It is this
 * class that is the last only if nothing else in the package is still booked
 * after it. A class with no package (a one-off) is never "the last".
 */
export function isLastClassOfPackage(
  pkg: { classesTotal: number; classesUsed: number } | null,
  laterScheduledInPackage: number,
): boolean {
  if (!pkg) return false;
  return pkg.classesUsed >= pkg.classesTotal && laterScheduledInPackage === 0;
}
