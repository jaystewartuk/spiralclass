// Whether THIS browser has already seen the captions privacy notice.
//
// Persisted per browser for the same reason the render preferences beside it
// are (see preferences.ts): it is a fact about one screen, it must survive a
// reload mid-lesson, and it has no business round-tripping through the
// database.
//
// WHY THE LEGACY KEY IS STILL READ. D-138 renamed the product and deliberately
// preserved every string naming a live external resource or persisted client
// state — the mobile SecureStore keys among them, so that a rename would not
// log two people out. This key is WEB localStorage and was neither on that
// protect list nor renamed with the rest, so it sat as `agendaprofe.*` beside
// a sibling `spiralclass.captionPreferences` written by the same feature.
// Renaming it outright is not free: the flag's whole job is to show a privacy
// explanation once, so dropping it re-shows a dismissed notice to whoever had
// already dismissed it. Reading the old key when the new one is absent costs
// one extra `getItem` on the first captions enable and loses nobody's
// dismissal, which is what makes the rename safe to actually finish.
//
// The legacy read can go once no browser that dismissed the notice before
// 2026-09-06 is still in use. Nothing tracks that, so it stays until someone
// decides the cost of being wrong is a notice shown twice.

export const CAPTIONS_NOTICE_STORAGE_KEY = "spiralclass.captionsNoticeSeen";

/** Pre-D-138 spelling of the same flag. Read-only — never written again. */
export const LEGACY_CAPTIONS_NOTICE_STORAGE_KEY = "agendaprofe.captionsNoticeSeen";

/** The one value either key is ever set to. */
const SEEN = "1";

// Pure half, so the decision is testable in node — same split preferences.ts,
// use-caption-ticker.ts and caption-feed.ts already use. The browser wiring
// lives in the component that owns the notice.
export function parseCaptionsNoticeSeen(current: string | null, legacy: string | null): boolean {
  return current === SEEN || legacy === SEEN;
}
