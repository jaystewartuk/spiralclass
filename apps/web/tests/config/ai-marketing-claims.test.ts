import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIVACY_POLICY_SECTIONS } from "@spiralclass/shared";
// REPO_ROOT / envFilePath / parseEnvFile are the config-tooling resolvers (D-85).
import { REPO_ROOT, envFilePath, parseEnvFile } from "../../../../scripts/env-config.mjs";

// Holds the public marketing pages' AI claims against the enablement flags that
// actually govern those features in production.
//
// Why this exists: the landing page and /features advertised "Pronunciation
// scoring — every word scored per phoneme" while
// LESSON_INSIGHTS_PRONUNCIATION_ENABLED was unset in
// config/env/production.runtime.env (and only a commented-out example on
// preview), so pronunciationEnabled() was false in every environment and no
// student had ever seen a phoneme score. Nothing failed: the claim lived in the
// i18n catalog, the flag lived in a config file, and no test connected them.
// That is the misalignment the pre-launch test session surfaced — a visitor
// being sold something signing up cannot reach.
//
// The check is deliberately two-directional:
//   1. Every claim a marketing page renders must be CLASSIFIED — either in
//      CLAIM_GATES (an AI capability, with the flags that back it) or in
//      NON_AI_CLAIMS. A new card belongs to neither by default, so it fails
//      until someone states which it is.
//   2. Every gate a rendered AI claim names must be on in
//      config/env/production.runtime.env.
// Rule (1) is what makes this durable — without it the guard would quietly stop
// covering whatever card someone adds next.
//
// Scope note: this checks the *enablement flags*, which are non-secret and
// version-controlled. It cannot check vendor credentials (DEEPGRAM_API_KEY,
// ANTHROPIC_API_KEY, GOOGLE_TTS_API_KEY/ELEVENLABS_API_KEY), which live in
// Infisical/`fly secrets` — a flag being on is necessary, not sufficient. The
// captions config header and D-94 make the same point: "flag on" has already
// once meant "silently dark" in this product's history.

const LANDING_PAGE = resolve(REPO_ROOT, "apps/web/src/app/page.tsx");
const FEATURES_PAGE = resolve(REPO_ROOT, "apps/web/src/app/features/page.tsx");
// The public booking page's buyer-reassurance band (`/b/<slug>`). It is a
// marketing surface in exactly the sense this guard cares about — a public page
// promising capabilities to someone about to pay — even though it sells the
// TEACHER rather than SpiralClass. Two of its lines are capability-gated.
const BOOKING_INCLUDED = resolve(REPO_ROOT, "apps/web/src/app/b/[slug]/whats-included.tsx");

// AI claim namespace → the production enablement flags that must ALL be on for
// the claim to be true. An empty array means the capability has no flag gate at
// all (credential-gated only, and it degrades to a hidden control rather than a
// broken promise) — still listed here, so rule (1) stays exhaustive.
const CLAIM_GATES: Record<string, string[]> = {
  // Live captions (D-27): teacher speaks Spanish, student reads English.
  "web.landing.ai.captions": ["LIVE_CAPTIONS_ENABLED"],
  "web.features.item.liveCaptions": ["LIVE_CAPTIONS_ENABLED"],

  // SM-2 vocabulary review. No flag: VocabularyReview rows seed from CONFIRMED
  // vocabulary-category insights, and a teacher can author those by hand
  // (insight-actions.ts addInsightFor, source:"teacher"), so the scheduler works
  // whether or not the (now-disabled) AI insights pipeline ever ran. That is
  // exactly why the copy says "vocabulary from your classes" rather than "each
  // lesson's vocabulary" — the automatic per-lesson derivation is the part that
  // went away with LESSON_INSIGHTS_TRANSCRIPTION_ENABLED.
  "web.landing.ai.srs": [],
  "web.features.item.srs": [],

  // Intro-video AI coach (D-73): AI feedback on the teacher's OWN public intro
  // video — deliberately outside the D-19/D-114 student-data gate. Pro-gated at
  // the pipeline, but every new teacher starts on the Pro trial, so a visitor
  // signing up today can reach it.
  "web.landing.ai.videoCoach": ["INTRO_VIDEO_COACH_ENABLED"],
  "web.features.item.videoCoach": ["INTRO_VIDEO_COACH_ENABLED"],

  // AI lesson insights (D-19 Phase B/C). D-114 cut these cards and moved the
  // keys to GATED_OFF_CLAIMS; D-131 turned the flag back on, which moves them
  // back here. The cards themselves are still NOT rendered — nothing obliges a
  // live capability to be advertised — so these entries are dormant until
  // someone puts the copy back, at which point this is the gate it must pass.
  "web.landing.ai.insights": ["LESSON_INSIGHTS_TRANSCRIPTION_ENABLED"],
  "web.features.item.aiInsights": ["LESSON_INSIGHTS_TRANSCRIPTION_ENABLED"],

  // The booking page's gated reassurance line. It is ALSO gated at render time
  // by the helper the flag feeds (`liveCaptionsEnabled()`), so a flag coming
  // off hides the line rather than leaving a false promise — this guard is the
  // second lock: turning the flag off in production without deleting the line
  // fails the build.
  "web.bookingLanding.included.captions": ["LIVE_CAPTIONS_ENABLED"],
};

// Everything else the two pages advertise: scheduling/payments/product surface
// with no AI enablement flag behind it. Listed so rule (1) can tell "not an AI
// claim" apart from "an AI claim nobody classified".
const NON_AI_CLAIMS = new Set([
  "web.features.item.booking",
  "web.features.item.calendar",
  "web.features.item.calendarSync",
  "web.features.item.chat",
  "web.features.item.getPaid",
  "web.features.item.globalPay",
  "web.features.item.library",
  "web.features.item.materials",
  "web.features.item.homeScreen",
  "web.features.item.notes",
  "web.features.item.pricing",
  "web.features.item.reminders",
  "web.features.item.videoLessons",
  // The landing page's everyday value props (web.landing.feature.*), scanned
  // because a flag-gated claim can land in that namespace too.
  "web.landing.feature.book",
  "web.landing.feature.calendar",
  "web.landing.feature.globalPay",
  "web.landing.feature.pay",
  "web.landing.feature.reminders",
  "web.landing.feature.video",
  // The booking page's ungated promises (web.bookingLanding.included.*). Each
  // is true for every teacher on every tier: none is behind an entitlement, and
  // "never paywall getting paid" keeps the purchase path itself free too.
  // Each class building on the last is the "continue from a previous class"
  // path in lib/materials/prompt.ts — a teacher-selected continuation, so the
  // claim is about what SHE does, not about a model deciding anything. The
  // materials line is deliberately worded the same way: it promises the
  // material is prepared around this student, never that AI wrote it. AI
  // compose is Pro-entitlement + quota gated (D-17) rather than flag-gated, so
  // claiming the mechanism here would promise something a Free teacher's page
  // could not keep — and would read to a student as "a robot prepares my
  // lessons", which is the opposite of the point.
  "web.bookingLanding.included.continuity",
  "web.bookingLanding.included.materials",
  // Handing work in and reading the feedback: plain CRUD on both platforms
  // since the web submit path landed, no entitlement and no vendor.
  "web.bookingLanding.included.homework",
  // The spaced vocabulary queue seeds from CONFIRMED vocabulary, which a
  // teacher can author by hand (insight-actions.ts addInsightFor,
  // source:"teacher"), so it works whether or not the AI insights pipeline ever
  // ran — the same reasoning as web.landing.ai.srs above. Gated at render on
  // her own `shareProgressByDefault`, which is a setting, not a flag.
  "web.bookingLanding.included.vocabulary",
  "web.bookingLanding.included.messages",
  "web.bookingLanding.included.reminders",
  "web.bookingLanding.included.reschedule",
  "web.bookingLanding.included.video",
]);

// Capabilities that must NOT be advertised while their flag is off. This is the
// regression half: re-adding any of these cards without also turning its flag on
// fails here rather than shipping.
//
// Podcasts joined pronunciation here in D-114, because podcasts had no flag at
// all until D-114 added one, so the only way to turn them off was to pull a
// vendor secret. Insights were here too until D-131 turned the transcription
// flag back on — they moved up to CLAIM_GATES.
const GATED_OFF_CLAIMS: Record<string, string> = {
  "web.landing.ai.pronunciation": "LESSON_INSIGHTS_PRONUNCIATION_ENABLED",
  "web.features.item.pronunciation": "LESSON_INSIGHTS_PRONUNCIATION_ENABLED",
  "web.landing.ai.podcast": "MATERIAL_PODCASTS_ENABLED",
  "web.features.item.podcast": "MATERIAL_PODCASTS_ENABLED",
};

const production = parseEnvFile(envFilePath("production", "runtime")).map as Record<string, string>;

/** The flag grammar every enablement gate in lib/ shares: 1 | true | on. */
function flagOn(name: string): boolean {
  const raw = production[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * The claim namespaces a marketing page renders. Reads the page source rather
 * than the catalog: the catalog can hold a key nothing renders (harmless), but a
 * rendered key is a promise on a public page.
 */
function claimsRenderedBy(path: string): string[] {
  const src = readFileSync(path, "utf8");
  const matched = new Set<string>();
  // Deliberately NOT anchored on `t(` any more: whats-included.tsx holds its
  // keys in a lookup table and renders them as `t(title)`, so a `t("…")`-only
  // scanner would report zero claims for that page and silently stop covering
  // it. Matching the quoted key literal anywhere in the rendering file fails
  // closed instead — a key mentioned in a comment counts as rendered, which is
  // the safe direction for a guard whose job is to catch false promises.
  for (const [, key] of src.matchAll(
    /"((?:web\.landing\.ai|web\.landing\.feature|web\.features\.item|web\.bookingLanding\.included)\.[A-Za-z0-9]+)\.(?:title|body)"/g,
  )) {
    matched.add(key);
  }
  return [...matched].sort();
}

const PAGES: Array<[string, string]> = [
  ["landing page", LANDING_PAGE],
  ["/features", FEATURES_PAGE],
  ["booking page", BOOKING_INCLUDED],
];

describe("public AI claims match production enablement flags", () => {
  for (const [label, path] of PAGES) {
    it(`${label}: the scanner actually sees claims on this page`, () => {
      // The classification test below passes vacuously when the scanner matches
      // nothing, so a page that quietly stops being covered — renamed keys, a
      // moved file, a regex that no longer fits how the page spells its keys —
      // reads as green. This is the tripwire for that: whats-included.tsx
      // already hit it once by holding its keys in a lookup table instead of
      // inline `t("…")` calls.
      expect(claimsRenderedBy(path).length).toBeGreaterThan(0);
    });

    it(`${label}: every advertised claim is classified`, () => {
      const unclassified = claimsRenderedBy(path).filter(
        (k) => !(k in CLAIM_GATES) && !NON_AI_CLAIMS.has(k),
      );
      expect(
        unclassified,
        unclassified.length
          ? `\nClaim(s) rendered on ${label} that this guard does not cover:\n` +
              unclassified.map((k) => `  ${k}`).join("\n") +
              `\n\nAdd each to CLAIM_GATES with the enablement flag(s) that make` +
              ` it true (an empty array if it is credential-gated only), or to` +
              ` NON_AI_CLAIMS if no AI enablement flag governs it.\n`
          : "",
      ).toEqual([]);
    });

    it(`${label}: every advertised AI claim's flags are on in production`, () => {
      const dark = claimsRenderedBy(path).flatMap((key) =>
        (CLAIM_GATES[key] ?? []).filter((flag) => !flagOn(flag)).map((flag) => `${key} → ${flag}`),
      );
      expect(
        dark,
        dark.length
          ? `\n${label} advertises capabilities whose flags are NOT on in` +
              ` config/env/production.runtime.env:\n` +
              dark.map((d) => `  ${d}`).join("\n") +
              `\n\nEither turn the flag on for production, or cut/soften the claim.\n`
          : "",
      ).toEqual([]);
    });

    it(`${label}: does not advertise a capability whose flag is off`, () => {
      const rendered = new Set(claimsRenderedBy(path));
      const advertised = Object.entries(GATED_OFF_CLAIMS)
        .filter(([key, flag]) => rendered.has(key) && !flagOn(flag))
        .map(([key, flag]) => `${key} (needs ${flag})`);
      expect(
        advertised,
        advertised.length
          ? `\n${label} advertises a capability that is off in production:\n` +
              advertised.map((a) => `  ${a}`).join("\n") +
              `\n\nIf the feature is genuinely live now, move it from` +
              ` GATED_OFF_CLAIMS to CLAIM_GATES in the same change that turns` +
              ` the flag on.\n`
          : "",
      ).toEqual([]);
    });
  }

  // Guards the premise of the three card removals: if any of these flags is
  // turned on, the corresponding test fails, and re-adding the marketing claim
  // becomes the correct fix. Asserted per flag rather than as one lump so the
  // failure names which capability came back.
  for (const flag of Object.values(GATED_OFF_CLAIMS).filter((f, i, all) => all.indexOf(f) === i)) {
    it(`${flag} is still off in production`, () => {
      expect(flagOn(flag)).toBe(false);
    });
  }

  // D-131 turned recording and transcription back on. Asserted positively for
  // the same reason D-114 asserted them off: these two decide whether a
  // student's voice is captured at all, so their state should be something a
  // test states out loud rather than something you learn by reading an env
  // file. Flipping either back off is a real decision — change this test in
  // the same commit, and restore the "switched off" sentences in
  // packages/shared/src/legal/privacy-policy.ts with it.
  it("class recording and transcription are on in production (D-131)", () => {
    expect(flagOn("CLASS_RECORDING_ENABLED")).toBe(true);
    expect(flagOn("LESSON_INSIGHTS_TRANSCRIPTION_ENABLED")).toBe(true);
  });

  // The privacy policy claimed, in four places, that recording/transcription
  // were switched off. D-131 rewrote all four; this is the tripwire that stops
  // the claim creeping back in while the flags say otherwise.
  it("the privacy policy does not claim these features are switched off", () => {
    const prose = JSON.stringify(PRIVACY_POLICY_SECTIONS);
    expect(prose).not.toMatch(/switched off in production/);
    expect(prose).not.toMatch(/Not stored at all/);
  });
});
