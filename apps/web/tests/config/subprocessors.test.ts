import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUBPROCESSORS,
  SUBPROCESSORS_REVIEWED,
  PRIVACY_POLICY_SECTIONS,
  coreSubprocessors,
  gatedSubprocessors,
} from "@spiralclass/shared";
// REPO_ROOT / envFilePath / parseEnvFile are the config-tooling resolvers (D-85).
import { REPO_ROOT, envFilePath, parseEnvFile } from "../../../../scripts/env-config.mjs";

// Holds the published sub-processor register against the vendor credentials the
// application's own env contract declares.
//
// Why this exists: a privacy policy's supplier list is the part that rots
// first. A vendor is added in a pull request, the policy is a page nobody
// re-opens, and the two drift apart silently — the reader is then being told
// something untrue about where their data goes, and nothing fails. This repo
// has already had the identical failure once in a different costume: the
// landing page advertised pronunciation scoring whose flag was off in every
// environment, because the copy lived in the i18n catalog, the flag lived in a
// config file, and no test joined them. `ai-marketing-claims.test.ts` is that
// join for marketing claims; this is that join for the privacy policy.
//
// The check is deliberately two-directional:
//   1. Every vendor credential `src/lib/env.ts` declares must be CLASSIFIED —
//      either mapped to a sub-processor entry, or listed in
//      NOT_A_PROCESSOR below with the reason. A new vendor env var belongs to
//      neither by default, so it fails until someone decides which it is.
//   2. Every gate a sub-processor names must be a real env var or a real
//      production flag, so the register cannot cite a gate that has been
//      renamed away.
//
// Scope note, stated as plainly as the marketing guard states its own: this
// checks that the LIST is complete and its gates are real. It cannot check that
// a `location` is accurate — that is a fact about a vendor's infrastructure, not
// about this repository — which is why `SUBPROCESSORS_REVIEWED` is rendered on
// the page: a reader can see the date the locations were last read, rather than
// trusting an undated table.

const ENV_CONTRACT = resolve(REPO_ROOT, "apps/web/src/lib/env.ts");

/**
 * Env vars that name a third party but do NOT make that third party a
 * processor of personal data. Each needs a reason, because "it's fine" is how
 * a real processor gets waved through.
 */
// The anomaly-detector thresholds are a count, not a data flow: nothing is sent
// anywhere and no third party is named. They are environment configuration only
// so the deployed values stay out of a public repository — see
// lib/inngest/functions/anomaly-alerts.ts. The alerts they raise go to Sentry,
// which IS registered.
const THRESHOLD_REASON = "A detection threshold (a number), not a vendor.";

const NOT_A_PROCESSOR: Record<string, string> = {
  // Public/asset identifiers and our own configuration, not a data flow.
  APP_URL: "Our own URL.",
  BETTER_AUTH_URL: "Our own URL.",
  BETTER_AUTH_SECRET: "Our own signing secret; better-auth runs in-process.",
  SESSION_SECRET: "Our own signing secret.",
  FIELD_ENCRYPTION_KEY: "Our own encryption key.",
  FIELD_ENCRYPTION_REQUIRED: "A boot-time assertion, not a vendor.",
  TENANCY_GUARD:
    "How loudly our own tenancy guard reacts to a cross-tenant query. No vendor, " +
    "and its reports carry model and operation names, never row values.",
  DATABASE_URL: "Points at Neon, which IS registered.",
  DIRECT_URL: "Points at Neon, which IS registered.",
  TEST_DATABASE_URL: "A local test database. Never holds real personal data.",
  NODE_ENV: "Not a vendor.",
  RTC_PROVIDER: "Selects between video providers; LiveKit IS registered.",
  JOBS_BACKEND: "Selects between job backends; Inngest IS registered.",
  EMAIL_PROVIDER: "Selects between email providers; both are registered.",
  ANOMALY_REFUND_THRESHOLD: THRESHOLD_REASON,
  ANOMALY_REFUND_PER_TEACHER_THRESHOLD: THRESHOLD_REASON,
  ANOMALY_TEACHER_DISABLE_THRESHOLD: THRESHOLD_REASON,
  ANOMALY_STUDENT_DISABLE_THRESHOLD: THRESHOLD_REASON,
  ANOMALY_FAILED_NOTIFICATIONS_THRESHOLD: THRESHOLD_REASON,
  ANOMALY_FAILED_PAYMENTS_THRESHOLD: THRESHOLD_REASON,
  ANOMALY_PUSH_FAILURE_THRESHOLD: THRESHOLD_REASON,

  // Credential halves of vendors already registered under another var.
  ANTHROPIC_MODEL: "A model name for Anthropic, which IS registered.",
  CAPTION_TRANSLATION_MODEL: "A model name for Anthropic, which IS registered.",
  GEMINI_IMAGE_MODEL: "A model name for Google, which IS registered.",
  GEMINI_VERTEX_PROJECT_ID: "A GCP project id for Google, which IS registered.",
  GEMINI_VERTEX_LOCATION: "A Vertex AI region for Google, which IS registered.",
  GOOGLE_CLIENT_SECRET: "The paired half of GOOGLE_CLIENT_ID.",
  GOOGLE_OAUTH_CLIENT_ID: "Google, which IS registered.",
  GOOGLE_OAUTH_CLIENT_SECRET: "Google, which IS registered.",
  GOOGLE_TTS_LANGUAGE_CODE: "A voice setting, not a credential.",
  GOOGLE_TTS_VOICE: "A voice setting, not a credential.",
  ELEVENLABS_MODEL_ID: "A voice setting, not a credential.",
  ELEVENLABS_VOICE_ID: "A voice setting, not a credential.",
  LIVEKIT_API_KEY: "LiveKit, which IS registered.",
  LIVEKIT_API_SECRET: "LiveKit, which IS registered.",
  LIVEKIT_URL: "LiveKit, which IS registered.",
  RESEND_FROM: "A sender address for Resend, which IS registered.",
  RESEND_WEBHOOK_SECRET: "Resend, which IS registered. A signature-verification key.",
  SES_FROM: "A sender address.",
  SES_REGION: "A region for SES.",
  SES_ACCESS_KEY_ID: "Amazon SES — the fallback email provider, unset in production.",
  SES_SECRET_ACCESS_KEY: "Amazon SES — the fallback email provider, unset in production.",
  STRIPE_SECRET_KEY: "Stripe, which IS registered.",
  STRIPE_WEBHOOK_SECRET: "Stripe, which IS registered.",
  STRIPE_BILLING_WEBHOOK_SECRET: "Stripe, which IS registered.",
  STRIPE_CONNECT_WEBHOOK_SECRET: "Stripe, which IS registered.",
  STRIPE_PRICE_MONTHLY: "A Stripe Price id.",
  STRIPE_PRICE_ANNUAL: "A Stripe Price id.",
  STRIPE_PRICE_FOUNDING: "A Stripe Price id.",
  STRIPE_BILLING_PORTAL_CONFIG_ID: "A Stripe Customer Portal configuration id.",
  STRIPE_TAX_ENABLED: "A Stripe setting.",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "Stripe, which IS registered.",
  NEXT_PUBLIC_POSTHOG_KEY: "PostHog, which IS registered.",
  NEXT_PUBLIC_POSTHOG_HOST: "PostHog, which IS registered.",
  NEXT_PUBLIC_POSTHOG_REGION: "PostHog, which IS registered.",
  POSTHOG_KEY: "PostHog, which IS registered.",
  POSTHOG_HOST: "PostHog, which IS registered.",
  POSTHOG_PERSONAL_API_KEY: "PostHog, which IS registered.",
  POSTHOG_PROJECT_ID: "PostHog, which IS registered. A project number, not a credential (D-158).",
  SENTRY_DSN: "Sentry, which IS registered.",
  NEXT_PUBLIC_SENTRY_DSN: "Sentry, which IS registered.",
  INNGEST_EVENT_KEY: "Inngest, which IS registered.",
  INNGEST_SIGNING_KEY: "Inngest, which IS registered.",
  WISE_API_BASE: "Wise, which IS registered.",

  // Vendors that never see personal data, or are not wired to production.
  UPSTASH_REDIS_REST_URL: "Rate-limit counters keyed by a hashed identifier. Unset in production.",
  UPSTASH_REDIS_REST_TOKEN: "Paired half of the above.",
  VAPID_PRIVATE_KEY: "Our own Web Push signing key. The push service is the browser vendor's.",
  VAPID_PUBLIC_KEY: "Our own Web Push signing key.",
  VAPID_SUBJECT: "A contact URL embedded in Web Push requests.",
  CAPTIONS_AGENT_SHARED_SECRET: "Our own shared secret between the app and the captions worker.",
  SUPERUSER_EMAILS: "Our own admin allowlist.",

  // Never-enabled or test-only.
  ASSEMBLYAI_API_KEY: "An alternative transcription vendor. Not wired to any live code path.",
  AZURE_SPEECH_KEY: "Pronunciation scoring, never enabled in any environment.",
  AZURE_SPEECH_REGION: "Paired half of the above.",
  E2E_RATE_LIMIT_BYPASS: "Test-only switch.",
  E2E_STRIPE_STUB: "Test-only switch.",

  // Feature flags — behaviour, not vendors. The ones that gate a vendor are
  // asserted separately below.
  CLASS_RECORDING_ENABLED: "A feature flag.",
  LESSON_INSIGHTS_PRONUNCIATION_ENABLED: "A feature flag.",
  LESSON_INSIGHTS_TRANSCRIPTION_ENABLED: "A feature flag.",
  LIVE_CAPTIONS_ENABLED: "A feature flag.",
};

/**
 * Vendor credentials that map onto a registered sub-processor. The value is
 * the sub-processor id, so a renamed entry fails here rather than silently
 * dropping a supplier off the published list.
 */
const CREDENTIAL_TO_SUBPROCESSOR: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  DEEPGRAM_API_KEY: "deepgram",
  GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: "google-ai",
  GOOGLE_CLIENT_ID: "google-sign-in",
  GOOGLE_TTS_API_KEY: "google-ai",
  ELEVENLABS_API_KEY: "elevenlabs",
  RESEND_API_KEY: "resend",
};

/** Every env key the web app's env contract declares. */
function declaredEnvKeys(): string[] {
  const src = readFileSync(ENV_CONTRACT, "utf8");
  // Zod schema entries are `KEY: <schema>` at the start of an indented line.
  const keys = [...src.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
  return [...new Set(keys)];
}

describe("sub-processor register", () => {
  it("classifies every vendor credential the env contract declares", () => {
    const unclassified = declaredEnvKeys().filter(
      (key) => !(key in NOT_A_PROCESSOR) && !(key in CREDENTIAL_TO_SUBPROCESSOR),
    );
    expect(
      unclassified,
      "A new env var is neither mapped to a sub-processor nor listed as not-a-processor. " +
        "If it names a company that can see personal data, add it to SUBPROCESSORS in " +
        "packages/shared/src/legal/subprocessors.ts so the published privacy policy shows it. " +
        "If it cannot, add it to NOT_A_PROCESSOR here WITH A REASON:\n" +
        unclassified.join("\n"),
    ).toEqual([]);
  });

  it("maps every credential to a sub-processor that actually exists", () => {
    const ids = new Set(SUBPROCESSORS.map((s) => s.id));
    const dangling = Object.entries(CREDENTIAL_TO_SUBPROCESSOR)
      .filter(([, id]) => !ids.has(id))
      .map(([key, id]) => `${key} → ${id}`);
    expect(
      dangling,
      `Mapped to a sub-processor id that no longer exists:\n${dangling.join("\n")}`,
    ).toEqual([]);
  });

  it("names a real gate on every gated sub-processor", () => {
    const envSrc = readFileSync(ENV_CONTRACT, "utf8");
    const prodEnv = parseEnvFile(envFilePath("production", "runtime"));
    const bogus = gatedSubprocessors()
      .filter((s) => s.gate !== null)
      .filter((s) => !envSrc.includes(s.gate as string) && !(s.gate! in prodEnv))
      .map((s) => `${s.id} cites gate ${s.gate}`);
    expect(
      bogus,
      `A sub-processor cites a gate that is neither in the env contract nor in the ` +
        `production runtime config — it has probably been renamed:\n${bogus.join("\n")}`,
    ).toEqual([]);
  });

  it("gives every entry the fields the published page renders", () => {
    for (const s of SUBPROCESSORS) {
      expect(s.name.length, `${s.id} has no name`).toBeGreaterThan(0);
      expect(s.purpose.length, `${s.id} has no purpose`).toBeGreaterThan(0);
      expect(s.dataShared.length, `${s.id} does not say what it sees`).toBeGreaterThan(0);
      expect(
        s.evidence.length,
        `${s.id} does not say where its location came from`,
      ).toBeGreaterThan(0);
    }
  });

  it("has unique ids", () => {
    const ids = SUBPROCESSORS.map((s) => s.id);
    expect(new Set(ids).size, `Duplicate sub-processor ids in ${ids.join(", ")}`).toBe(ids.length);
  });

  it("splits cleanly into core and gated, covering every entry", () => {
    expect(coreSubprocessors().length + gatedSubprocessors().length).toBe(SUBPROCESSORS.length);
    expect(coreSubprocessors().every((s) => s.gate === null)).toBe(true);
    expect(gatedSubprocessors().every((s) => s.gate !== null)).toBe(true);
  });

  it("carries a review date in ISO form", () => {
    expect(SUBPROCESSORS_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("privacy policy", () => {
  it("renders the supplier register rather than restating it in prose", () => {
    const hasRegisterBlock = PRIVACY_POLICY_SECTIONS.some((section) =>
      section.blocks.some((block) => block.kind === "subprocessors"),
    );
    expect(
      hasRegisterBlock,
      "The policy must render the register block, or the guard above protects a list nobody sees.",
    ).toBe(true);
  });

  it("names a lawful basis for every purpose it states", () => {
    const rows = PRIVACY_POLICY_SECTIONS.flatMap((section) =>
      section.blocks.flatMap((block) => (block.kind === "basisTable" ? block.rows : [])),
    );
    expect(rows.length, "The policy states no lawful bases at all").toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.purpose.length, "A lawful-basis row has no purpose").toBeGreaterThan(0);
      expect(row.data.length, `"${row.purpose}" names no data`).toBeGreaterThan(0);
    }
  });

  it("states the legitimate interest wherever it relies on one", () => {
    // UK GDPR requires the interest to be identified, not merely the basis
    // named. A row that says "Legitimate interests" and stops is not compliant.
    const missing = PRIVACY_POLICY_SECTIONS.flatMap((section) =>
      section.blocks.flatMap((block) => (block.kind === "basisTable" ? block.rows : [])),
    )
      .filter((row) => row.basis === "Legitimate interests" && !row.interest)
      .map((row) => row.purpose);
    expect(
      missing,
      `These rows rely on legitimate interests without naming the interest:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("carries the sections a UK GDPR privacy notice has to have", () => {
    // Article 13's transparency requirements, as section ids. A future edit that
    // drops one of these fails here rather than in a complaint.
    const required = [
      "who-we-are",
      "what-we-collect",
      "why-we-use-it",
      "who-we-share-with",
      "transfers",
      "retention",
      "your-rights",
      "contact",
    ];
    const present = new Set(PRIVACY_POLICY_SECTIONS.map((s) => s.id));
    const absent = required.filter((id) => !present.has(id));
    expect(absent, `The policy is missing required sections:\n${absent.join("\n")}`).toEqual([]);
  });

  it("tells the reader they can complain to the supervisory authority", () => {
    const text = JSON.stringify(PRIVACY_POLICY_SECTIONS);
    expect(text).toContain("Information Commissioner");
    expect(text).toContain("ico.org.uk");
  });

  it("no longer describes a Mexican-law regime", () => {
    // The document this replaced was an LFPDPPP `aviso` with ARCO rights. A
    // regression to that framing would be silent otherwise: both documents look
    // like "a privacy page" from the outside.
    const text = JSON.stringify(PRIVACY_POLICY_SECTIONS).toLowerCase();
    for (const term of ["lfpdppp", "arco", "aviso de privacidad", "inai"]) {
      expect(text, `The policy still refers to ${term}`).not.toContain(term);
    }
  });
});
