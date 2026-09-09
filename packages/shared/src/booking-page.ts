// What the public booking page (`/b/<slug>`) promises a prospective student,
// beyond the teacher's own photo/video/packages.
//
// Why this lives in shared rather than in either client: the "what's included"
// band renders on BOTH web (`app/b/[slug]/whats-included.tsx`) and mobile
// (`app/b/[slug]/index.tsx`), and every line of it is a public promise about
// what the buyer gets. Two hand-maintained lists would drift, and the failure
// mode of drift here is a claim on one platform that the other doesn't back —
// the same class of problem `tests/config/ai-marketing-claims.test.ts` exists
// to catch. One ordered list, one gate per capability, both clients render it.
//
// Pure data: the caller resolves the capability flags (server-side env gates on
// web, the `/api/mobile/public/teacher/[slug]` payload on mobile) and this
// decides only WHICH items are true for that teacher, in what order.

/**
 * One reassurance item. Each maps to a `web.bookingLanding.included.<item>`
 * title/body pair in the shared catalog, and — for the two capability-gated
 * ones — to an enablement flag the marketing-claims guard holds it against.
 */
export type IncludedItem =
  | "continuity"
  | "captions"
  | "materials"
  | "homework"
  | "vocabulary"
  | "video"
  | "reschedule"
  | "reminders"
  | "messages";

/**
 * The platform capabilities that decide whether the gated items are true for
 * THIS teacher right now.
 *
 * - `liveCaptions` — `liveCaptionsEnabled()`: LIVE_CAPTIONS_ENABLED plus the
 *   ASR/translation vendor keys. Off means captions are dark, not just hidden.
 */
export type BookingPageCapabilities = {
  liveCaptions: boolean;
  /**
   * `Teacher.shareProgressByDefault` — whether this teacher shares each
   * student's learning profile (and so the spaced vocabulary review that seeds
   * from it) with the student. No platform flag and no vendor behind it: the
   * queue seeds from confirmed vocabulary a teacher can author by hand, so the
   * only thing that decides whether the promise is true is her own setting.
   */
  progressSharing: boolean;
};

// Ordered DIFFERENTIATION-first, then reassurance.
//
// This used to be ordered purely as reassurance for someone about to send money
// to a stranger, and that half is unchanged and still last. What was missing is
// the half above it: a visitor comparing this teacher to a marketplace tutor
// needs to know what is different about HER classes before being told the
// booking is safe. Every item below the fold of that comparison — rescheduling,
// reminders, messaging — is something Preply and italki also do, so leading
// with them sells nothing.
//
// The differentiating items lead: each class continuing the last (the spiral
// the product is named after — see brand/mark.ts), then subtitles, then
// materials prepared for this student, then the work that goes between classes.
// The always-true items stay in a fixed order so the band reads identically on
// both platforms regardless of which gated items happen to be on.
const ALWAYS_INCLUDED: readonly IncludedItem[] = [
  "continuity",
  "materials",
  "homework",
  "video",
  "reschedule",
  "reminders",
  "messages",
] as const;

/**
 * The items to render, in display order. Gated items are dropped entirely
 * rather than shown disabled — an unavailable capability must never appear as
 * a promise on a public page.
 */
export function includedItemsFor(capabilities: BookingPageCapabilities): IncludedItem[] {
  const items: IncludedItem[] = [...ALWAYS_INCLUDED];
  // Captions sit second when present — directly under "each class continues the
  // last" and above everything else. It answers the objection that actually
  // stops a beginner booking a class in a language they can't follow yet, and
  // it is the single capability no marketplace tutor can offer at all.
  //
  // (It used to sit after the "class runs in your browser" line, as a property
  // of the video rather than a reason to choose this teacher. That reading is
  // true and much less useful.)
  if (capabilities.liveCaptions) items.splice(items.indexOf("continuity") + 1, 0, "captions");
  // The vocabulary review is the teacher's own setting, not a platform flag —
  // dropped entirely rather than shown when she does not share progress, since
  // an unavailable capability must never appear as a promise.
  if (capabilities.progressSharing) {
    items.splice(items.indexOf("homework") + 1, 0, "vocabulary");
  }
  return items;
}
