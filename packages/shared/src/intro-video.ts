// Intro-video shared model (D-73). Pure logic the web `<video>` card needs, so
// playback analytics come from one set of thresholds rather than each caller
// inventing its own.
//
// Everything here is deliberately free of DOM types: it takes plain seconds and
// returns plain data, so one unit test covers it.

// The length we coach teachers toward. Used by the recorder's on-screen guide,
// the AI coach prompt's checklist, and the length verdict below — one source of
// truth so the recorder, the coach and the help copy can never disagree.
export const INTRO_VIDEO_IDEAL_MIN_SEC = 30;
export const INTRO_VIDEO_IDEAL_MAX_SEC = 60;

// How a finished take compares to the ideal window. Surfaced to the teacher
// immediately after recording (before upload) so she can retake on the spot,
// rather than waiting for the async AI coach to tell her the same thing after
// the clip is already public.
export type IntroVideoLengthVerdict = "too-short" | "ideal" | "slightly-long" | "too-long";

export function introVideoLengthVerdict(durationSec: number): IntroVideoLengthVerdict {
  if (durationSec < INTRO_VIDEO_IDEAL_MIN_SEC) return "too-short";
  if (durationSec <= INTRO_VIDEO_IDEAL_MAX_SEC) return "ideal";
  if (durationSec <= INTRO_VIDEO_IDEAL_MAX_SEC * 1.5) return "slightly-long";
  return "too-long";
}

// --- Playback progress -------------------------------------------------------

// Quartile milestones. 100 is reported as its own `intro_video_completed`
// event, so it is deliberately NOT in this list — a milestone here always means
// "still watching", which keeps the drop-off curve readable.
export const INTRO_VIDEO_PROGRESS_MILESTONES = [25, 50, 75] as const;

export type IntroVideoProgressMilestone = (typeof INTRO_VIDEO_PROGRESS_MILESTONES)[number];

// Which milestones a timeupdate at `currentSec` has newly crossed, given the
// ones already reported. Returns them in ascending order so a viewer who seeks
// forward still emits an ordered, gap-free funnel rather than skipping steps
// (a seek past 50% would otherwise make the 25%→50% drop-off look like a cliff).
//
// Returns [] for a non-finite/zero duration — a `<video>` reports NaN duration
// until metadata loads, and 0/0 must never read as "100% watched".
export function introVideoNewMilestones(
  currentSec: number,
  durationSec: number,
  alreadyReported: readonly number[],
): IntroVideoProgressMilestone[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  if (!Number.isFinite(currentSec) || currentSec < 0) return [];
  const percent = (currentSec / durationSec) * 100;
  return INTRO_VIDEO_PROGRESS_MILESTONES.filter(
    (m) => percent >= m && !alreadyReported.includes(m),
  );
}

// --- Watch accounting --------------------------------------------------------

// Rolling account of a single visitor's session with one intro video, so the
// "watch duration / completion / repeat views" questions are answered from one
// summary event at unmount rather than by summing a noisy stream of timeupdates.
//
// `watchedSec` counts time ACTUALLY advanced during playback (it accumulates
// forward deltas only), so a viewer who scrubs backwards and rewatches a
// section doesn't inflate it past the clip length, and a forward seek doesn't
// credit skipped seconds as watched. `maxPercent` is the furthest point
// reached — the two together distinguish "watched it all" from "skipped to
// the end".
export type IntroVideoWatchState = {
  watchedSec: number;
  maxPercent: number;
  playCount: number;
  completed: boolean;
};

export function emptyIntroVideoWatchState(): IntroVideoWatchState {
  return { watchedSec: 0, maxPercent: 0, playCount: 0, completed: false };
}

// Fold one timeupdate into the state. `lastSec` is the previous tick's position;
// pass null on the first tick after a play/seek so the gap isn't counted.
export function foldIntroVideoTick(
  state: IntroVideoWatchState,
  currentSec: number,
  lastSec: number | null,
  durationSec: number,
): IntroVideoWatchState {
  if (!Number.isFinite(currentSec) || currentSec < 0) return state;
  // Only forward motion within a plausible tick window counts as watched — a
  // jump larger than this is a seek, not viewing time.
  const MAX_TICK_SEC = 2;
  const delta =
    lastSec != null && currentSec > lastSec && currentSec - lastSec <= MAX_TICK_SEC
      ? currentSec - lastSec
      : 0;
  const percent =
    Number.isFinite(durationSec) && durationSec > 0
      ? Math.min(100, (currentSec / durationSec) * 100)
      : state.maxPercent;
  return {
    ...state,
    watchedSec: state.watchedSec + delta,
    maxPercent: Math.max(state.maxPercent, percent),
  };
}

// The properties the summary event carries. Rounded here (not at each call
// site) so web and mobile report identically-shaped numbers.
export function introVideoWatchSummary(state: IntroVideoWatchState): {
  watched_ms: number;
  max_percent: number;
  play_count: number;
  completed: boolean;
} {
  return {
    watched_ms: Math.round(state.watchedSec * 1000),
    max_percent: Math.round(state.maxPercent),
    play_count: state.playCount,
    completed: state.completed,
  };
}
