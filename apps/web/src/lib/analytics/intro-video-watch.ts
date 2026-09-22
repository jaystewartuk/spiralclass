// "Did this buyer watch the intro video?" — the one question that decides
// whether the whole intro-video feature earns its keep, and the one PostHog
// can't answer from playback events alone.
//
// A funnel of `intro_video_play → checkout_started` tells you how many watchers
// bought, but NOT how that compares to non-watchers, because the two groups sit
// in different funnels with different denominators. Stamping the checkout event
// itself with the visitor's watch state puts both cohorts in ONE event with a
// breakdown property, which is a single insight rather than a hand-computed
// ratio between two.
//
// Deliberately sessionStorage, not a cookie or a Person property:
//   * it must survive the /b/<slug> → /b/<slug>/buy navigation (so not React
//     state), which is the entire journey it needs to cover;
//   * booking-page visitors are anonymous (`person_profiles: "identified_only"`),
//     so there is no Person to set a property on at watch time;
//   * it is analytics-only and must not outlive the visit, so it never becomes
//     something to disclose or purge — sessionStorage dies with the tab.
//
// Keyed by booking SLUG, not teacher id: the slug is what both the booking page
// and the checkout page already have in hand (1:1 with the teacher on this
// public funnel), so nothing has to be prop-drilled through checkout just to
// read a flag back. A visitor comparing two teachers still can't have one
// teacher's watch credited to the other's checkout.

const KEY_PREFIX = "ap.introVideoWatched.";

export type IntroVideoWatchMark = {
  watched: boolean;
  maxPercent: number;
};

// Record (or upgrade) the visitor's furthest point in this teacher's intro.
// Monotonic — a replay that stops early never downgrades an earlier full watch.
// Every failure mode (Safari private mode, storage disabled, SSR) is swallowed:
// this is telemetry, and it must never break a booking page.
export function markIntroVideoWatched(slug: string, maxPercent: number): void {
  try {
    if (typeof window === "undefined") return;
    const key = KEY_PREFIX + slug;
    const previous = Number(window.sessionStorage.getItem(key));
    const next = Math.max(Number.isFinite(previous) ? previous : 0, Math.round(maxPercent), 0);
    window.sessionStorage.setItem(key, String(next));
  } catch {
    // ignore
  }
}

// Read the mark back at checkout time. Returns watched:false when the visitor
// never pressed play — which is the control group, not missing data.
export function readIntroVideoWatch(slug: string): IntroVideoWatchMark {
  try {
    if (typeof window === "undefined") return { watched: false, maxPercent: 0 };
    const raw = window.sessionStorage.getItem(KEY_PREFIX + slug);
    if (raw === null) return { watched: false, maxPercent: 0 };
    const percent = Number(raw);
    return { watched: true, maxPercent: Number.isFinite(percent) ? percent : 0 };
  } catch {
    return { watched: false, maxPercent: 0 };
  }
}
