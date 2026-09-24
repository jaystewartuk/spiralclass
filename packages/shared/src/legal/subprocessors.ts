// The sub-processor register — the single source of truth for "who else
// touches personal data, what for, and where."
//
// It lives in @spiralclass/shared because BOTH clients render the privacy
// policy from it (web `/privacy-notice`, mobile `app/privacy-notice.tsx`).
// Before this existed the two pages were separately hand-written documents
// that had already drifted: web ran a bilingual hand-written notice and mobile ran
// a five-card summary asserting a different controller. A privacy policy that
// disagrees with itself across platforms is worse than a short one.
//
// WHY A CODE REGISTER RATHER THAN PROSE. A privacy policy's sub-processor list
// is the part that rots first: a vendor is added in a pull request, the policy
// is a page nobody re-opens, and the two silently diverge. Here the list IS
// code, and `apps/web/tests/config/subprocessors.test.ts` holds it against the
// vendor credentials the env contract actually declares — in both directions,
// so a new vendor env var fails the build until someone classifies it. Same
// shape, and the same reasoning, as `ai-marketing-claims.test.ts`, which exists
// because marketing copy and a production feature flag had drifted apart with
// nothing joining them.
//
// LOCATIONS. Four are verifiable from this repository and are cited inline.
// The rest are the vendor's own published primary processing region, read on
// the date in `SUBPROCESSORS_REVIEWED` below. Re-read them when that date gets
// old; do not guess, and do not widen a location to "global" to avoid checking.

/** Where a sub-processor primarily processes personal data. */
export type ProcessingLocation = "United States" | "United Kingdom" | "European Union" | "Global";

export type Subprocessor = {
  /** Stable id — also the anchor the policy page renders. */
  id: string;
  /** The vendor's own name, as a data subject would recognise it. */
  name: string;
  /** What we use them for, in one plain sentence. */
  purpose: string;
  /** The categories of personal data they can see. */
  dataShared: string;
  location: ProcessingLocation;
  /**
   * The production enablement flag or credential that gates this vendor, or
   * null when the vendor is unconditional infrastructure. A gated vendor
   * receives nothing at all while its gate is off — which is why the policy
   * renders those in a separate, clearly-labelled group rather than implying
   * every name here is live today.
   */
  gate: string | null;
  /**
   * Where the location claim comes from. A repo-relative path when this
   * repository proves it; "vendor documentation" when it does not.
   */
  evidence: string;
};

/**
 * The date the vendor-documented locations below were last read. The policy
 * page renders it, so a reader can see how fresh the list is instead of
 * trusting an undated table.
 */
export const SUBPROCESSORS_REVIEWED = "2026-08-25";

export const SUBPROCESSORS: readonly Subprocessor[] = [
  // ---- Unconditional infrastructure -------------------------------------
  {
    id: "google-cloud-run",
    name: "Google Cloud",
    purpose: "Runs the application servers that serve the website and its API.",
    dataShared: "Everything you send us passes through these servers in transit.",
    location: "United States",
    gate: null,
    // config/cloudrun/production.env: REGION=us-east4 (N. Virginia). Replaced
    // Fly.io on 2026-09-23 (D-184's addendum).
    evidence: "config/cloudrun/production.env",
  },
  {
    id: "neon",
    name: "Neon",
    purpose: "Hosts the PostgreSQL database that stores your account and class records.",
    dataShared: "Account details, class and payment history, messages, homework.",
    location: "United States",
    // infra/database/neon/README.md pins the production project to aws-us-east-1
    // (N. Virginia); it was aws-us-east-2 (Ohio) until 2026-09-24. Both are
    // "United States", so the published location did not change.
    gate: null,
    evidence: "infra/database/neon/README.md",
  },
  {
    id: "cloudflare-r2",
    name: "Cloudflare R2",
    purpose: "Stores uploaded files — profile photos, intro videos, materials, homework.",
    dataShared: "Files you upload, and the images and audio the product generates for you.",
    location: "Global",
    gate: null,
    evidence: "vendor documentation",
  },
  {
    id: "stripe",
    name: "Stripe",
    purpose: "Takes card payments, and pays teachers whose country Stripe Connect supports.",
    dataShared: "Name, email, payment details, and the amount and date of each payment.",
    location: "United States",
    gate: null,
    evidence: "vendor documentation",
  },
  {
    id: "resend",
    name: "Resend",
    purpose: "Delivers the transactional email we send you.",
    dataShared: "Your email address and the contents of that email.",
    location: "United States",
    gate: null,
    evidence: "vendor documentation",
  },
  {
    id: "inngest",
    name: "Inngest",
    purpose: "Runs background jobs — reminders, payout transfers, scheduled clean-up.",
    dataShared: "The identifiers a job needs; not message or lesson content.",
    location: "United States",
    gate: null,
    evidence: "vendor documentation",
  },
  {
    id: "sentry",
    name: "Sentry",
    purpose: "Records application errors so we can fix them.",
    dataShared:
      "Technical error data and your account identifier. Personal fields are scrubbed before they are sent.",
    location: "United States",
    // SENTRY_DSN in config/env/production.runtime.env points at ingest.us.sentry.io.
    gate: null,
    evidence: "config/env/production.runtime.env",
  },
  {
    id: "posthog",
    name: "PostHog",
    purpose: "Product analytics and session replay, so we can see which parts of the product work.",
    dataShared:
      "Pages visited, actions taken, device and approximate location from your IP address, and your account identifier once you sign in.",
    location: "United States",
    // POSTHOG_HOST in config/env/production.runtime.env is us.i.posthog.com.
    gate: null,
    evidence: "config/env/production.runtime.env",
  },
  {
    id: "google-sign-in",
    name: "Google",
    purpose: "Optional Google Sign-In, and optional calendar sync if you connect it.",
    dataShared:
      "Your name and email from your Google account; busy times from your calendar if you connect it.",
    location: "United States",
    gate: null,
    evidence: "vendor documentation",
  },
  {
    id: "wise",
    name: "Wise",
    purpose:
      "Reconciles incoming transfers for teachers who take payment through a Wise account rather than by card.",
    dataShared:
      "The teacher's own Wise handle and the payment reference. Where a teacher instead takes payment straight into a bank account, no third party is involved at all. We never see a student's bank credentials either way.",
    location: "United Kingdom",
    gate: null,
    evidence: "vendor documentation",
  },
  {
    id: "livekit",
    name: "LiveKit (self-hosted)",
    purpose: "Carries the audio and video of a live class between the two participants.",
    dataShared: "Live audio and video, in transit. Nothing is stored on this server.",
    location: "Global",
    gate: null,
    evidence: "config/env/production.runtime.env",
  },

  // ---- Feature-gated: nothing reaches these unless the feature is on ------
  {
    id: "anthropic",
    name: "Anthropic",
    purpose:
      "Powers the AI features: drafting lesson materials, reviewing homework, and writing promotional posts.",
    dataShared:
      "Only the text you submit to that feature — a material you are drafting, a homework answer, or your own teaching profile.",
    location: "United States",
    gate: "ANTHROPIC_API_KEY",
    evidence: "vendor documentation",
  },
  {
    id: "deepgram",
    name: "Deepgram",
    // Live captions joined on 2026-09-23 (D-185's addendum): the fallback
    // for a class where no device can recognise speech, streamed from the
    // speaker's own browser and opted out of Deepgram's model training.
    purpose:
      "Converts speech to text for intro-video coaching; where the student has consented, for post-class lesson transcripts; and for live captions in a class where no device in the call can recognise speech itself.",
    dataShared:
      "The audio of the teacher's intro video, of a consenting student's side of a class, or — for live captions — the speech of the teacher or a consenting student while captions are on.",
    location: "United States",
    gate: "DEEPGRAM_API_KEY",
    evidence: "vendor documentation",
  },
  // Live captions (D-185). Speech is recognised by the web browser of a
  // participant in the call — on the device when the browser has the model,
  // otherwise by that browser's own speech service — and each finished line
  // is translated on the device or, failing that, by Google Cloud
  // Translation through our server. The browser's service is not a vendor we
  // contract with (the participant's browser chooses it), but it is where the
  // audio goes, so it is listed rather than left to the reader to guess.
  {
    id: "browser-speech",
    name: "Your web browser's speech service (Google, for Chrome)",
    purpose:
      "Recognises speech for live captions when the browser cannot do it on the device itself.",
    dataShared:
      "The audio of a class participant whose speech is being captioned — the teacher's, or a consenting student's.",
    location: "Global",
    gate: "LIVE_CAPTIONS_ENABLED",
    // The browser picks its own servers and does not publish a region.
    evidence: "not published by the browser vendor",
  },
  {
    id: "google-translate",
    name: "Google Cloud Translation",
    purpose: "Translates live captions when the browser cannot translate on the device.",
    dataShared:
      "The text of one finished caption at a time. Never audio, and nothing that says who spoke.",
    // Cloud Translation - Basic (v2) has only global endpoints; data cannot
    // be pinned to a region (Google's Cloud Translation data-usage FAQ, read
    // 2026-09-23 — after the date below, which covers the other entries).
    location: "Global",
    gate: "GOOGLE_TRANSLATE_API_KEY",
    evidence: "vendor documentation",
  },
  {
    id: "google-ai",
    name: "Google (Gemini and Cloud Text-to-Speech)",
    purpose:
      "Generates the images used on promotional posts and social previews, and can narrate a study podcast from a teacher's own material.",
    dataShared:
      "The prompt text we build from your public profile, or the material being narrated. No student data.",
    location: "United States",
    gate: "SOCIAL_PREVIEW_AI_ENABLED",
    evidence: "vendor documentation",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    purpose:
      "The alternative narrator for a study podcast generated from a teacher's own material.",
    dataShared: "The narration script generated from the material. No student data.",
    location: "United States",
    // Podcasts are switched off in every environment today (D-114 added the
    // flag precisely so "off" would be a reviewable diff), so nothing reaches
    // this vendor at all. It is listed rather than omitted because the register
    // describes what CAN happen, and the page renders it under the heading that
    // says so.
    gate: "MATERIAL_PODCASTS_ENABLED",
    evidence: "vendor documentation",
  },
] as const;

/** The sub-processors that receive data unconditionally. */
export function coreSubprocessors(): readonly Subprocessor[] {
  return SUBPROCESSORS.filter((s) => s.gate === null);
}

/** The sub-processors that receive nothing unless their feature is enabled. */
export function gatedSubprocessors(): readonly Subprocessor[] {
  return SUBPROCESSORS.filter((s) => s.gate !== null);
}

/** Every distinct location the register names, for the transfers section. */
export function subprocessorLocations(): readonly ProcessingLocation[] {
  return [...new Set(SUBPROCESSORS.map((s) => s.location))];
}
