import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLIENT_ENV_KEYS, SERVER_ENV_KEYS } from "@/lib/env";

// `env.ts` caches the parsed server schema in module state. We re-import
// in each block so process.env mutations actually take effect.

const ORIGINAL = { ...process.env };

// Keys the env module recognizes. Scrubbed before each patch so ambient
// values (real credentials in a CI/build env like Vercel) never leak into
// cases that assert a var is absent — otherwise process.env carries, say,
// a real INNGEST_SIGNING_KEY and "only one inngest key set" reads as both.
const APP_ENV_KEYS = [...SERVER_ENV_KEYS, ...CLIENT_ENV_KEYS];

function setEnv(patch: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL };
  for (const k of APP_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function withBaseRequired(extra: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: "postgres://x/y",
    DIRECT_URL: "postgres://x/y",
    SESSION_SECRET: "a".repeat(32),
    ...extra,
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("isSuperuser", () => {
  it("returns false for null/empty/undefined emails", async () => {
    setEnv(withBaseRequired({ SUPERUSER_EMAILS: "" }));
    const { isSuperuser } = await import("@/lib/env");
    expect(isSuperuser(null)).toBe(false);
    expect(isSuperuser(undefined)).toBe(false);
    expect(isSuperuser("")).toBe(false);
  });

  it("returns true for an email in the SUPERUSER_EMAILS list (case-insensitive)", async () => {
    setEnv(withBaseRequired({ SUPERUSER_EMAILS: "MIRA@example.com, ops@example.com" }));
    const { isSuperuser } = await import("@/lib/env");
    expect(isSuperuser("mira@example.com")).toBe(true);
    expect(isSuperuser("MIRA@EXAMPLE.COM")).toBe(true);
    expect(isSuperuser("Ops@Example.com")).toBe(true);
  });

  it("returns false for emails not in the list", async () => {
    setEnv(withBaseRequired({ SUPERUSER_EMAILS: "ops@example.com" }));
    const { isSuperuser } = await import("@/lib/env");
    expect(isSuperuser("intruder@example.com")).toBe(false);
  });

  it("treats SUPERUSER_EMAILS='' as empty allowlist", async () => {
    setEnv(withBaseRequired({ SUPERUSER_EMAILS: "" }));
    const { isSuperuser } = await import("@/lib/env");
    expect(isSuperuser("anyone@example.com")).toBe(false);
  });
});

describe("hasStripeCreds / hasResendCreds / hasInngestCreds", () => {
  it("returns true only when BOTH stripe vars are present", async () => {
    setEnv(
      withBaseRequired({
        STRIPE_SECRET_KEY: "sk_test_xxx",
        STRIPE_WEBHOOK_SECRET: "whsec_xxx",
      }),
    );
    const { hasStripeCreds } = await import("@/lib/env");
    expect(hasStripeCreds()).toBe(true);
  });

  it("returns false if either stripe var is blank", async () => {
    setEnv(
      withBaseRequired({
        STRIPE_SECRET_KEY: "sk_test_xxx",
        STRIPE_WEBHOOK_SECRET: "",
      }),
    );
    const { hasStripeCreds } = await import("@/lib/env");
    expect(hasStripeCreds()).toBe(false);
  });

  it("treats blank-string env values as absent (blankAsAbsent preprocess)", async () => {
    setEnv(withBaseRequired({ RESEND_API_KEY: "" }));
    const { hasResendCreds } = await import("@/lib/env");
    expect(hasResendCreds()).toBe(false);

    // env caches the parsed schema in module state — reset before the second
    // pass so the new RESEND_API_KEY value is re-read.
    vi.resetModules();
    setEnv(withBaseRequired({ RESEND_API_KEY: "re_xxx" }));
    const { hasResendCreds: again } = await import("@/lib/env");
    expect(again()).toBe(true);
  });

  it("hasSesCreds requires region, access key id, AND secret access key", async () => {
    setEnv(
      withBaseRequired({
        SES_REGION: "us-east-1",
        SES_ACCESS_KEY_ID: "AKIA_TEST",
        SES_SECRET_ACCESS_KEY: "secret",
      }),
    );
    const { hasSesCreds } = await import("@/lib/env");
    expect(hasSesCreds()).toBe(true);

    vi.resetModules();
    setEnv(withBaseRequired({ SES_REGION: "us-east-1", SES_ACCESS_KEY_ID: "AKIA_TEST" }));
    const { hasSesCreds: missingSecret } = await import("@/lib/env");
    expect(missingSecret()).toBe(false);
  });

  it("requires both inngest keys", async () => {
    setEnv(
      withBaseRequired({
        INNGEST_EVENT_KEY: "k",
        INNGEST_SIGNING_KEY: "s",
      }),
    );
    const { hasInngestCreds } = await import("@/lib/env");
    expect(hasInngestCreds()).toBe(true);

    vi.resetModules();
    setEnv(withBaseRequired({ INNGEST_EVENT_KEY: "k" }));
    const { hasInngestCreds: a2 } = await import("@/lib/env");
    expect(a2()).toBe(false);
  });

  it("hasGoogleAuthCreds requires BOTH login OAuth vars", async () => {
    setEnv(
      withBaseRequired({
        GOOGLE_CLIENT_ID: "gid",
        GOOGLE_CLIENT_SECRET: "gsecret",
      }),
    );
    const { hasGoogleAuthCreds } = await import("@/lib/env");
    expect(hasGoogleAuthCreds()).toBe(true);

    vi.resetModules();
    setEnv(withBaseRequired({ GOOGLE_CLIENT_ID: "gid" }));
    const { hasGoogleAuthCreds: onlyId } = await import("@/lib/env");
    expect(onlyId()).toBe(false);
  });

  it("hasGoogleAuthCreds is independent of the Calendar OAuth client", async () => {
    // The busy-import client (GOOGLE_OAUTH_*) must NOT satisfy the login gate,
    // and vice-versa — they are deliberately separate OAuth clients.
    setEnv(
      withBaseRequired({
        GOOGLE_OAUTH_CLIENT_ID: "cal-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "cal-secret",
      }),
    );
    const { hasGoogleAuthCreds, hasGoogleCalendarCreds } = await import("@/lib/env");
    expect(hasGoogleCalendarCreds()).toBe(true);
    expect(hasGoogleAuthCreds()).toBe(false);
  });
});

describe("jobsBackend", () => {
  it("defaults to inngest when JOBS_BACKEND is unset", async () => {
    setEnv(withBaseRequired({ JOBS_BACKEND: undefined }));
    const { jobsBackend } = await import("@/lib/env");
    expect(jobsBackend()).toBe("inngest");
  });

  it("returns pgboss only when explicitly set", async () => {
    setEnv(withBaseRequired({ JOBS_BACKEND: "pgboss" }));
    const { jobsBackend } = await import("@/lib/env");
    expect(jobsBackend()).toBe("pgboss");
  });

  it("falls back to inngest on a blank value (blankAsAbsent)", async () => {
    setEnv(withBaseRequired({ JOBS_BACKEND: "" }));
    const { jobsBackend } = await import("@/lib/env");
    expect(jobsBackend()).toBe("inngest");
  });
});

describe("serverEnv() default + cache", () => {
  it("defaults APP_URL to the production canonical when unset", async () => {
    setEnv(withBaseRequired({ APP_URL: undefined }));
    const { serverEnv } = await import("@/lib/env");
    expect(serverEnv().APP_URL).toBe("https://spiralclass.com");
  });

  it("respects an explicit APP_URL", async () => {
    setEnv(withBaseRequired({ APP_URL: "http://localhost:3000" }));
    const { serverEnv } = await import("@/lib/env");
    expect(serverEnv().APP_URL).toBe("http://localhost:3000");
  });

  it("throws when a required var is missing", async () => {
    setEnv({ ...withBaseRequired(), DATABASE_URL: undefined });
    const { serverEnv } = await import("@/lib/env");
    expect(() => serverEnv()).toThrow(/DATABASE_URL/);
  });

  it("caches across calls (subsequent .env mutations do not re-read)", async () => {
    setEnv(withBaseRequired({ APP_URL: "http://localhost:3000" }));
    const { serverEnv } = await import("@/lib/env");
    const first = serverEnv().APP_URL;
    // Mutate after first call — cached result must persist.
    process.env.APP_URL = "https://evil.example.com";
    expect(serverEnv().APP_URL).toBe(first);
  });
});

describe("anthropicApiKey", () => {
  it("returns undefined when unset or blank", async () => {
    setEnv(withBaseRequired({ ANTHROPIC_API_KEY: undefined }));
    const { anthropicApiKey } = await import("@/lib/env");
    expect(anthropicApiKey()).toBeUndefined();
  });

  it("returns the key as-is when it isn't wrapped in quotes", async () => {
    setEnv(withBaseRequired({ ANTHROPIC_API_KEY: "sk-ant-real-key-123" }));
    const { anthropicApiKey } = await import("@/lib/env");
    expect(anthropicApiKey()).toBe("sk-ant-real-key-123");
  });

  it("strips one layer of surrounding quotes — the same copy-paste mistake fixed for DEEPGRAM_API_KEY (deepgramApiKey), which made Anthropic reject the key and every /api/captions/translate call fail with a 502", async () => {
    setEnv(withBaseRequired({ ANTHROPIC_API_KEY: '"sk-ant-real-key-123"' }));
    const { anthropicApiKey } = await import("@/lib/env");
    expect(anthropicApiKey()).toBe("sk-ant-real-key-123");
  });

  it("trims surrounding whitespace before and after unwrapping quotes", async () => {
    setEnv(withBaseRequired({ ANTHROPIC_API_KEY: '  "sk-ant-real-key-123"  ' }));
    const { anthropicApiKey } = await import("@/lib/env");
    expect(anthropicApiKey()).toBe("sk-ant-real-key-123");
  });
});

describe("hasAnthropicCreds", () => {
  it("is true even when the key is quote-wrapped (sanitized first)", async () => {
    setEnv(withBaseRequired({ ANTHROPIC_API_KEY: '"sk-ant-real-key-123"' }));
    const { hasAnthropicCreds } = await import("@/lib/env");
    expect(hasAnthropicCreds()).toBe(true);
  });

  it("is false when unset", async () => {
    setEnv(withBaseRequired({ ANTHROPIC_API_KEY: undefined }));
    const { hasAnthropicCreds } = await import("@/lib/env");
    expect(hasAnthropicCreds()).toBe(false);
  });
});

describe("geminiVertexServiceAccount", () => {
  function base64Of(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString("base64");
  }

  it("returns undefined when unset", async () => {
    setEnv(withBaseRequired({ GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: undefined }));
    const { geminiVertexServiceAccount } = await import("@/lib/env");
    expect(geminiVertexServiceAccount()).toBeUndefined();
  });

  it("decodes a valid base64-JSON key into its two fields", async () => {
    const encoded = base64Of({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "PEM" });
    setEnv(withBaseRequired({ GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: encoded }));
    const { geminiVertexServiceAccount } = await import("@/lib/env");
    expect(geminiVertexServiceAccount()).toEqual({
      clientEmail: "sa@x.iam.gserviceaccount.com",
      privateKey: "PEM",
    });
  });

  it("strips one layer of surrounding quotes before decoding — the same copy-paste mistake as ANTHROPIC_API_KEY", async () => {
    const encoded = base64Of({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "PEM" });
    setEnv(withBaseRequired({ GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: `"${encoded}"` }));
    const { geminiVertexServiceAccount } = await import("@/lib/env");
    expect(geminiVertexServiceAccount()).toEqual({
      clientEmail: "sa@x.iam.gserviceaccount.com",
      privateKey: "PEM",
    });
  });

  it("returns undefined rather than throwing on invalid base64/JSON", async () => {
    setEnv(
      withBaseRequired({ GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: "not-valid-base64-json!!" }),
    );
    const { geminiVertexServiceAccount } = await import("@/lib/env");
    expect(geminiVertexServiceAccount()).toBeUndefined();
  });

  it("returns undefined when the decoded JSON is missing a required field", async () => {
    const encoded = base64Of({ client_email: "sa@x.iam.gserviceaccount.com" });
    setEnv(withBaseRequired({ GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: encoded }));
    const { geminiVertexServiceAccount } = await import("@/lib/env");
    expect(geminiVertexServiceAccount()).toBeUndefined();
  });
});

describe("hasGeminiImageCreds", () => {
  const validAccount = Buffer.from(
    JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "PEM" }),
  ).toString("base64");

  it("is true only when both the service account AND the project id are set", async () => {
    setEnv(
      withBaseRequired({
        GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: validAccount,
        GEMINI_VERTEX_PROJECT_ID: "example-project-00000",
      }),
    );
    const { hasGeminiImageCreds } = await import("@/lib/env");
    expect(hasGeminiImageCreds()).toBe(true);
  });

  it("is false when the project id is missing, even with a valid credential", async () => {
    setEnv(
      withBaseRequired({
        GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: validAccount,
        GEMINI_VERTEX_PROJECT_ID: undefined,
      }),
    );
    const { hasGeminiImageCreds } = await import("@/lib/env");
    expect(hasGeminiImageCreds()).toBe(false);
  });

  it("is false when unset", async () => {
    setEnv(
      withBaseRequired({
        GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: undefined,
        GEMINI_VERTEX_PROJECT_ID: undefined,
      }),
    );
    const { hasGeminiImageCreds } = await import("@/lib/env");
    expect(hasGeminiImageCreds()).toBe(false);
  });
});

describe("geminiVertexLocation", () => {
  it("defaults to global — the only location gemini-3.1-flash-image is published to", async () => {
    setEnv(withBaseRequired({ GEMINI_VERTEX_LOCATION: undefined }));
    const { geminiVertexLocation } = await import("@/lib/env");
    expect(geminiVertexLocation()).toBe("global");
  });

  it("is overridable via env", async () => {
    setEnv(withBaseRequired({ GEMINI_VERTEX_LOCATION: "us-central1" }));
    const { geminiVertexLocation } = await import("@/lib/env");
    expect(geminiVertexLocation()).toBe("us-central1");
  });
});

describe("anthropicModel", () => {
  // D-87: deliberately Sonnet 5, not the most-capable model (Opus) — cost — and
  // deliberately NOT Haiku like the four short lesson-notes/intro-coach
  // constants, because this one's call sites pass `effort` (see the guard test
  // below).
  it("defaults to claude-sonnet-5 when unset", async () => {
    setEnv(withBaseRequired({ ANTHROPIC_MODEL: undefined }));
    const { anthropicModel } = await import("@/lib/env");
    expect(anthropicModel()).toBe("claude-sonnet-5");
  });

  it("respects an explicit override", async () => {
    setEnv(withBaseRequired({ ANTHROPIC_MODEL: "claude-custom-smart" }));
    const { anthropicModel } = await import("@/lib/env");
    expect(anthropicModel()).toBe("claude-custom-smart");
  });

  // INVARIANT (D-87): every anthropicModel() call site in lib/ai/anthropic.ts
  // — generateMaterial, refineMaterial, generatePodcastScript,
  // generateMaterialStream — passes `output_config: { effort: "medium" }`.
  // The Anthropic API REJECTS `effort` with a 400 on pre-4.6 models (Sonnet
  // 4.5, Haiku 4.5, …); it is supported on Opus 4.5 (low/medium/high only) and
  // on 4.6+ models. So this default must name an effort-capable model, or every
  // material generation 400s in production. A blanket D-87 switch to
  // claude-haiku-4-5 would have done exactly that.
  //
  // If you legitimately change the default, add the new model here only after
  // confirming it supports `output_config.effort` at the levels the call sites
  // use. If you instead remove `effort` from all four call sites, delete this
  // test in the same change and say so in the commit.
  it("defaults to a model that supports output_config.effort", async () => {
    const EFFORT_CAPABLE_MODELS = [
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
    ];
    setEnv(withBaseRequired({ ANTHROPIC_MODEL: undefined }));
    const { anthropicModel } = await import("@/lib/env");
    expect(EFFORT_CAPABLE_MODELS).toContain(anthropicModel());
  });
});

describe("captionTranslationModel", () => {
  it("defaults to claude-haiku-4-5 when unset", async () => {
    setEnv(withBaseRequired({ CAPTION_TRANSLATION_MODEL: undefined }));
    const { captionTranslationModel } = await import("@/lib/env");
    expect(captionTranslationModel()).toBe("claude-haiku-4-5");
  });

  it("respects an explicit override", async () => {
    setEnv(withBaseRequired({ CAPTION_TRANSLATION_MODEL: "claude-custom-fast" }));
    const { captionTranslationModel } = await import("@/lib/env");
    expect(captionTranslationModel()).toBe("claude-custom-fast");
  });
});

describe("clientEnv()", () => {
  it("parses the NEXT_PUBLIC_* subset only", async () => {
    setEnv(
      withBaseRequired({
        NEXT_PUBLIC_SENTRY_DSN: "https://pub@sentry.io/1",
        NEXT_PUBLIC_POSTHOG_KEY: "phc_pub",
      }),
    );
    const { clientEnv } = await import("@/lib/env");
    expect(clientEnv()).toMatchObject({
      NEXT_PUBLIC_SENTRY_DSN: "https://pub@sentry.io/1",
      NEXT_PUBLIC_POSTHOG_KEY: "phc_pub",
    });
  });

  it("parses when the optional NEXT_PUBLIC_* vars are absent", async () => {
    // Every client var is optional (Sentry/PostHog degrade gracefully), so a
    // build without them must parse rather than throw. See lib/env.ts.
    setEnv(withBaseRequired());
    const { clientEnv } = await import("@/lib/env");
    expect(() => clientEnv()).not.toThrow();
    expect(clientEnv().NEXT_PUBLIC_SENTRY_DSN).toBeUndefined();
  });
});

describe("hasStripeEmbeddedCheckout()", () => {
  it("is false when the publishable key isn't configured (checkout stays hosted)", async () => {
    setEnv(withBaseRequired({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: undefined }));
    const { hasStripeEmbeddedCheckout } = await import("@/lib/env");
    expect(hasStripeEmbeddedCheckout()).toBe(false);
  });

  it("is true once the publishable key is set", async () => {
    setEnv(withBaseRequired({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x" }));
    const { hasStripeEmbeddedCheckout } = await import("@/lib/env");
    expect(hasStripeEmbeddedCheckout()).toBe(true);
  });
});

describe("assertProductionCredentials", () => {
  it("is a no-op outside production", async () => {
    setEnv(withBaseRequired({ NODE_ENV: "development" }));
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).not.toThrow();
  });

  it("throws on the production deployment when required credentials are missing", async () => {
    // Production is the canonical apex APP_URL (no "preview" in the host).
    setEnv(withBaseRequired({ NODE_ENV: "production" }));
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).toThrow(/Missing required production/);
  });

  it("is a no-op on a preview host even when creds are missing", async () => {
    // Preview builds with NODE_ENV=production too, but degrades gracefully.
    // Prod-vs-preview is decided by APP_URL (Vercel's VERCEL_ENV is gone, D-89).
    setEnv(
      withBaseRequired({
        NODE_ENV: "production",
        APP_URL: "https://preview.spiralclass.com",
      }),
    );
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).not.toThrow();
  });

  it("does not throw in production when ALL required credentials are set", async () => {
    setEnv(
      withBaseRequired({
        NODE_ENV: "production",
        RESEND_API_KEY: "re_xxx",
        INNGEST_EVENT_KEY: "evt",
        INNGEST_SIGNING_KEY: "sig",
        SENTRY_DSN: "https://x@sentry.io/y",
        POSTHOG_KEY: "ph_xxx",
        POSTHOG_HOST: "https://posthog.example.com",
      }),
    );
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).not.toThrow();
  });

  it("does not throw in production when SES creds satisfy the email requirement (no Resend key)", async () => {
    setEnv(
      withBaseRequired({
        NODE_ENV: "production",
        SES_REGION: "us-east-1",
        SES_ACCESS_KEY_ID: "AKIA_TEST",
        SES_SECRET_ACCESS_KEY: "secret",
        INNGEST_EVENT_KEY: "evt",
        INNGEST_SIGNING_KEY: "sig",
        SENTRY_DSN: "https://x@sentry.io/y",
        POSTHOG_KEY: "ph_xxx",
        POSTHOG_HOST: "https://posthog.example.com",
      }),
    );
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).not.toThrow();
  });

  it("throws in production when neither Resend nor SES creds are set", async () => {
    setEnv(
      withBaseRequired({
        NODE_ENV: "production",
        INNGEST_EVENT_KEY: "evt",
        INNGEST_SIGNING_KEY: "sig",
        SENTRY_DSN: "https://x@sentry.io/y",
        POSTHOG_KEY: "ph_xxx",
        POSTHOG_HOST: "https://posthog.example.com",
      }),
    );
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).toThrow(/Email \(SES_REGION/);
  });
});

describe("assertProductionCredentials — field-encryption guard", () => {
  // All other required prod creds set, so only the field-encryption checks vary.
  const prodCreds = (extra: Record<string, string | undefined> = {}) =>
    withBaseRequired({
      NODE_ENV: "production",
      RESEND_API_KEY: "re_xxx",
      INNGEST_EVENT_KEY: "evt",
      INNGEST_SIGNING_KEY: "sig",
      SENTRY_DSN: "https://x@sentry.io/y",
      POSTHOG_KEY: "ph_xxx",
      POSTHOG_HOST: "https://posthog.example.com",
      ...extra,
    });
  const VALID_KEY = Buffer.alloc(32).toString("base64");

  it("pre-rollout (flag unset, no key) boots fine — plaintext is the documented default", async () => {
    setEnv(prodCreds());
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).not.toThrow();
  });

  it("rejects a malformed key (not 32 bytes) at boot, even pre-cutover", async () => {
    setEnv(prodCreds({ FIELD_ENCRYPTION_KEY: "tooshort" }));
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).toThrow(
      /FIELD_ENCRYPTION_KEY must decode to 32 bytes/,
    );
  });

  it("once the cutover flag is set, refuses to boot without a key (no silent plaintext)", async () => {
    setEnv(prodCreds({ FIELD_ENCRYPTION_REQUIRED: "1" }));
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).toThrow(/FIELD_ENCRYPTION_REQUIRED is set/);
  });

  it("boots when the cutover flag is set AND a valid 32-byte key is present", async () => {
    setEnv(prodCreds({ FIELD_ENCRYPTION_REQUIRED: "1", FIELD_ENCRYPTION_KEY: VALID_KEY }));
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).not.toThrow();
  });

  it("does not enforce the key requirement on a preview deployment", async () => {
    setEnv(
      prodCreds({ FIELD_ENCRYPTION_REQUIRED: "1", APP_URL: "https://preview.spiralclass.com" }),
    );
    const { assertProductionCredentials } = await import("@/lib/env");
    expect(() => assertProductionCredentials()).not.toThrow();
  });
});

// D-114. Podcasts were the one student-facing AI surface with no enablement
// flag — availability was decided purely by whether a TTS key happened to be
// present, so the only way to turn them off was to pull a secret. These lock
// the two-condition shape (a vendor is configured AND the flag is on) that
// every other AI capability in this codebase already has.
describe("podcastsEnabled — material podcasts gate", () => {
  it("is off when the flag is unset, even with a TTS key present", async () => {
    // Explicitly cleared: the flag is read straight off process.env rather than
    // declared in the schema, so setEnv's APP_ENV_KEYS scrub doesn't reach it
    // and an ambient value would otherwise decide this case.
    setEnv(
      withBaseRequired({ MATERIAL_PODCASTS_ENABLED: undefined, ELEVENLABS_API_KEY: "el-key" }),
    );
    const { podcastsEnabled, hasTtsCreds } = await import("@/lib/env");
    expect(hasTtsCreds()).toBe(true);
    expect(podcastsEnabled()).toBe(false);
  });

  it("is off when the flag is on but no TTS rail is configured", async () => {
    setEnv(withBaseRequired({ MATERIAL_PODCASTS_ENABLED: "1" }));
    const { podcastsEnabled } = await import("@/lib/env");
    expect(podcastsEnabled()).toBe(false);
  });

  it("is on with the flag set and either rail configured", async () => {
    for (const rail of ["ELEVENLABS_API_KEY", "GOOGLE_TTS_API_KEY"]) {
      setEnv(withBaseRequired({ MATERIAL_PODCASTS_ENABLED: "1", [rail]: "k" }));
      vi.resetModules();
      const { podcastsEnabled } = await import("@/lib/env");
      expect(podcastsEnabled(), rail).toBe(true);
    }
  });

  it("accepts the same 1 | true | on grammar as every other enablement flag", async () => {
    for (const raw of ["1", "true", "TRUE", "on", " On "]) {
      setEnv(withBaseRequired({ MATERIAL_PODCASTS_ENABLED: raw, ELEVENLABS_API_KEY: "k" }));
      vi.resetModules();
      const { podcastsEnabled } = await import("@/lib/env");
      expect(podcastsEnabled(), raw).toBe(true);
    }
    for (const raw of ["0", "false", "off", "yes", ""]) {
      setEnv(withBaseRequired({ MATERIAL_PODCASTS_ENABLED: raw, ELEVENLABS_API_KEY: "k" }));
      vi.resetModules();
      const { podcastsEnabled } = await import("@/lib/env");
      expect(podcastsEnabled(), raw).toBe(false);
    }
  });
});
