import { z } from "zod";
import { logger } from "@/lib/logger";

const log = logger({ surface: "env" });

// `.env` files load missing values as `""`, not `undefined`, so a plain
// `.optional()` on a `.min(1)` string still fails validation when the
// key is present-but-blank. Treat empty strings as absent for every
// optional field below.
const blankAsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema);

const serverSchema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
  // (Supabase is fully retired — D-89 decommission. The database is Neon and
  // object storage is Cloudflare R2, see lib/storage/provider.ts. The
  // SUPABASE_* / NEXT_PUBLIC_SUPABASE_* vars and the Storage rollback provider
  // were removed once the soak completed.)
  // Defaults to the production canonical host so a missing env still resolves
  // to the brand domain (rather than a thrown error). Override locally to
  // http://localhost:3000 and per-deploy on preview (config/env/*.runtime.env).
  APP_URL: z.string().url().default("https://spiralclass.com"),
  SESSION_SECRET: z.string().min(16),
  // better-auth (D-40 — replaces Supabase Auth). Optional in the schema so a
  // build never breaks when unset (e.g. a preview env before cutover); the auth
  // instance guards at runtime via betterAuthConfigured(). Preview + production
  // must set these before the sign-in path is exercised on the new rail.
  //   * BETTER_AUTH_SECRET: signing secret for better-auth sessions + bearer
  //     tokens (>= 32 chars). Dedicated — NOT SESSION_SECRET, which stays for the
  //     /r/* + opt-out HMAC capability tokens.
  //   * BETTER_AUTH_URL: canonical base URL for better-auth; defaults to APP_URL.
  BETTER_AUTH_SECRET: blankAsAbsent(z.string().min(32).optional()),
  BETTER_AUTH_URL: blankAsAbsent(z.string().url().optional()),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // How the tenancy guard (lib/tenancy/guard.ts) reacts to a query that names
  // a tenant other than the one being served. Unset means "report" in
  // production and "enforce" everywhere else — see `guardMode()`, which reads
  // process.env directly because it sits on the import path of lib/prisma.ts
  // and cannot afford to require a complete environment.
  TENANCY_GUARD: z.enum(["off", "report", "enforce"]).optional(),
  // Stripe (Slice 8) — optional in dev so the slice builds and tests
  // against the stub client. Production requires both; enforced at
  // runtime by `hasStripeCreds()` below. See the pre-launch spec.
  //
  //   * STRIPE_SECRET_KEY: platform secret (sk_live_*/sk_test_*). Used
  //     for ALL server-side calls — Connect account creation, Checkout
  //     Sessions, refunds, subscription reads, invoice reads. A direct charge
  //     on a teacher's account is authenticated by the platform key plus a
  //     `Stripe-Account` header (D-143), not a per-account key, so this stays
  //     the only secret key we hold.
  //   * STRIPE_WEBHOOK_SECRET: HMAC secret for the PLATFORM event destination
  //     on /api/stripe/webhook. Verified on every POST; 503s in prod if missing.
  //   * STRIPE_CONNECT_WEBHOOK_SECRET: HMAC secret for the CONNECTED-ACCOUNTS
  //     destination on that SAME path.
  //
  //     Two destinations legitimately deliver to one route, and each Stripe
  //     endpoint has its own signing secret. Both are load-bearing under D-143:
  //     a teacher's PAYMENT events arrive on the connected-accounts
  //     destination, while the v2 account event that flips her
  //     charges_enabled after onboarding arrives on the PLATFORM one — because
  //     her account belongs directly to this platform, and Accounts v2 routes
  //     those to "Your account" rather than "Connected accounts" as v1 did.
  //     Verifying only one means the other 401s forever, which fails silently
  //     in a different place depending on which you picked.
  STRIPE_SECRET_KEY: blankAsAbsent(z.string().min(1).optional()),
  STRIPE_WEBHOOK_SECRET: blankAsAbsent(z.string().min(1).optional()),
  STRIPE_CONNECT_WEBHOOK_SECRET: blankAsAbsent(z.string().min(1).optional()),
  // Subscription billing (docs/features/subscriptions.md). Stripe Billing runs on the
  // SAME platform secret key (STRIPE_SECRET_KEY) — these are the Price IDs
  // (created out-of-band in the Stripe dashboard) plus a SEPARATE webhook
  // secret for the billing endpoint. All optional/warn-only, matching the
  // Stripe-optional treatment: when the price ids or billing secret are
  // missing, the paywall is hidden and everyone stays on Free/trial so dev
  // boots. See hasBillingCreds() below.
  STRIPE_PRICE_MONTHLY: blankAsAbsent(z.string().min(1).optional()),
  STRIPE_PRICE_ANNUAL: blankAsAbsent(z.string().min(1).optional()),
  STRIPE_PRICE_FOUNDING: blankAsAbsent(z.string().min(1).optional()),
  // The Customer Portal configuration this repo declares, applied by
  // `pnpm stripe:portal:sync` (see lib/stripe/portal-configuration.ts).
  // Deliberately NOT in hasBillingCreds(): unset, Stripe falls back to its own
  // lazily-created default and the portal still opens, just with plan
  // switching off. Billing must not become unavailable over an unpinned
  // configuration.
  STRIPE_BILLING_PORTAL_CONFIG_ID: blankAsAbsent(z.string().min(1).optional()),
  STRIPE_BILLING_WEBHOOK_SECRET: blankAsAbsent(z.string().min(1).optional()),
  // Tax kill-switch (global-launch item 7). "1"/"true" turns on Stripe Tax
  // (automatic_tax) at checkout on both rails; default off. The buyer's billing
  // address is captured regardless (see stripeTaxEnabled() + billing-address.ts),
  // so flipping this needs no backfill. It has prerequisites outside the
  // codebase that the flag does not enforce, hence off by default.
  STRIPE_TAX_ENABLED: blankAsAbsent(z.string().min(1).optional()),
  // Resend email fallback (Slice 4). Missing key → stub email client.
  // RESEND_FROM overrides the sender address (bare email — display name is
  // added in code). Defaults to no-reply@updates.spiralclass.com.
  //
  // Neither environment's value is committed — both are Fly secrets, set from
  // Infisical (there is no RESEND_* entry in either fly.*.toml [env] block).
  //
  // Production is `soporte@updates.spiralclass.com`. That domain was created in
  // Resend during the D-138 rename with its own DKIM key published, so it is
  // the one sender here that is genuinely verified. **Preview is deliberately
  // NOT symmetric**: it stays on `soporte@updates.staging.agendaprofe.com`,
  // which has never been a verified Resend domain — the account holds
  // `updates.agendaprofe.com` and `updates.spiralclass.com` and nothing else.
  // See D-138's unresolved-risks section; that asymmetry predates the rename.
  //
  // An unverified sender, or an API key scoped to a domain the sender no longer
  // uses, is not a soft failure: Resend answers `POST /emails` with a **403**
  // and the mail is never queued. On the sign-in path that locks the account
  // out entirely (AGENDAPROFE-1V), so check the Resend dashboard's Domains tab
  // and the API key's domain scope before changing either value.
  RESEND_API_KEY: blankAsAbsent(z.string().min(1).optional()),
  RESEND_FROM: blankAsAbsent(z.string().email().optional()),
  // Svix signing secret (`whsec_…`) for Resend's delivery-receipt webhook at
  // /api/resend/webhook. Absent, email notifications stop at `sent` — which
  // only ever meant "the API accepted it", not that anyone received it. See
  // lib/notifications/email-webhook.ts.
  RESEND_WEBHOOK_SECRET: blankAsAbsent(z.string().min(1).optional()),
  // Amazon SES (SESv2 SendEmail, raw MIME) — metered, no monthly floor,
  // unlike Resend's flat-fee tiers. Preferred over Resend when both are
  // configured (see getEmailClient() in lib/email/index.ts); EMAIL_PROVIDER
  // forces a specific provider (e.g. to roll back to Resend without
  // unsetting the SES creds). All optional — missing → falls through to
  // Resend, then the stub client, same degrade-gracefully pattern as every
  // other vendor here.
  SES_REGION: blankAsAbsent(z.string().min(1).optional()),
  SES_ACCESS_KEY_ID: blankAsAbsent(z.string().min(1).optional()),
  SES_SECRET_ACCESS_KEY: blankAsAbsent(z.string().min(1).optional()),
  SES_FROM: blankAsAbsent(z.string().email().optional()),
  EMAIL_PROVIDER: blankAsAbsent(z.enum(["ses", "resend"]).optional()),
  // Anthropic API (AI post-class lesson summary + class-content compose, D-17).
  // Optional — missing key means the AI actions return a friendly error instead
  // of calling out, so dev + tests run without a key. Production sets it via
  // Vercel env. ANTHROPIC_MODEL optionally overrides the model (defaults to
  // claude-sonnet-5 as of D-87); routed through the PLATFORM key only, never
  // per-teacher. NOTE: this override reaches anthropicModel() ONLY — the four
  // hardcoded lesson-notes/intro-coach constants ignore it entirely.
  ANTHROPIC_API_KEY: blankAsAbsent(z.string().min(1).optional()),
  ANTHROPIC_MODEL: blankAsAbsent(z.string().min(1).optional()),
  // ElevenLabs text-to-speech — renders a material's generated script into a
  // single-narrator podcast mp3. Optional, like ANTHROPIC_API_KEY: missing key
  // means the "Generate podcast" action is hidden/blocked, never a page break.
  // VOICE_ID/MODEL_ID override the defaults (a stock voice + the multilingual
  // model, since scripts are es-MX/other target languages).
  ELEVENLABS_API_KEY: blankAsAbsent(z.string().min(1).optional()),
  ELEVENLABS_VOICE_ID: blankAsAbsent(z.string().min(1).optional()),
  ELEVENLABS_MODEL_ID: blankAsAbsent(z.string().min(1).optional()),
  // Google Cloud Text-to-Speech — the preferred podcast TTS rail: cheap
  // pay-as-you-go (a perpetual free monthly tier on Neural2) and, unlike
  // ElevenLabs' free tier, not blocked when called from a datacenter IP. When
  // set it wins over ElevenLabs; when neither is set the podcast action is
  // hidden/blocked (never a page break). VOICE/LANGUAGE_CODE override the
  // per-locale defaults resolved in google-tts.ts.
  // Gemini image generation — the social-preview image rail (D-123), served
  // through VERTEX AI rather than the public Generative Language API (AI
  // Studio). That switch (D-127) is entirely about billing, not the model:
  // AI Studio's API-key surface gates every call on a separate "Prepay"
  // balance with no postpaid option, while Vertex bills the SAME model
  // through ordinary Cloud Billing — the account already used for every
  // other GCP charge here. Off-GCP (Fly, not GCP) means no ambient
  // credential, so a service account key is the only auth path; see
  // lib/ai/google-vertex-auth.ts. All optional, exactly like
  // ANTHROPIC_API_KEY/GOOGLE_TTS_API_KEY: missing means the "Generate with
  // AI" control is hidden and the server refuses, while uploading an image
  // and every existing share link keep working.
  GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64: blankAsAbsent(z.string().min(1).optional()),
  GEMINI_VERTEX_PROJECT_ID: blankAsAbsent(z.string().min(1).optional()),
  GEMINI_VERTEX_LOCATION: blankAsAbsent(z.string().min(1).optional()),
  GEMINI_IMAGE_MODEL: blankAsAbsent(z.string().min(1).optional()),
  GOOGLE_TTS_API_KEY: blankAsAbsent(z.string().min(1).optional()),
  GOOGLE_TTS_VOICE: blankAsAbsent(z.string().min(1).optional()),
  GOOGLE_TTS_LANGUAGE_CODE: blankAsAbsent(z.string().min(1).optional()),
  // In-class video call (live-notes-panel.md step 3, D-16). LiveKit behind the
  // VideoProvider seam. All optional — missing any one means the call surface
  // degrades to a friendly "video not available" message (dev/test run without
  // them). The websocket URL is returned to the client in the join grant, so it
  // does NOT need a NEXT_PUBLIC_ copy.
  LIVEKIT_URL: blankAsAbsent(z.string().url().optional()),
  LIVEKIT_API_KEY: blankAsAbsent(z.string().min(1).optional()),
  LIVEKIT_API_SECRET: blankAsAbsent(z.string().min(1).optional()),
  // Selects the active VideoProvider implementation
  // (docs/features/live-calls-video.md) — a
  // non-secret enum, read straight from process.env by
  // lib/video/providers/index.ts (same never-depend-on-the-whole-schema
  // rationale as the LIVEKIT_* vars above); declared here for
  // documentation/typing. Only "livekit" exists today; unset defaults to it.
  RTC_PROVIDER: blankAsAbsent(z.enum(["livekit"]).optional()),
  // Inngest (Slice 4). Missing keys → stub Inngest client (events become
  // no-op logs); the /api/inngest serve handler still works for local dev
  // when run with `npx inngest-cli dev` pointed at the server.
  INNGEST_EVENT_KEY: blankAsAbsent(z.string().min(1).optional()),
  INNGEST_SIGNING_KEY: blankAsAbsent(z.string().min(1).optional()),
  // Background-jobs backend switch (docs/architecture/overview.md).
  // Selects which system lib/jobs/enqueue.ts's enqueue() routes to
  // and whether instrumentation.ts boots the in-process pg-boss worker.
  // Defaults to "inngest" — flipping to "pgboss" is a deliberate per-Phase
  // cutover step (the student portal), never an incidental side effect of this schema
  // change. See jobsBackend() below.
  JOBS_BACKEND: blankAsAbsent(z.enum(["inngest", "pgboss"]).optional()),
  // Anomaly-detection thresholds (lib/inngest/functions/anomaly-alerts.ts).
  // How many of each signal in an hour raise a Sentry alert. Read straight from
  // process.env by anomalyThresholds() — same reason as the VAPID keys below, and
  // because the hourly cron must not depend on the whole schema validating —
  // and declared here for documentation. Optional: absent or unparseable falls
  // back to the in-code default, which is deliberately NOT the deployed value.
  // A public repository that states the live numbers tells a reader exactly how
  // much of each abuse signal stays under the alarm.
  ANOMALY_REFUND_THRESHOLD: blankAsAbsent(z.coerce.number().int().positive().optional()),
  ANOMALY_REFUND_PER_TEACHER_THRESHOLD: blankAsAbsent(
    z.coerce.number().int().positive().optional(),
  ),
  ANOMALY_TEACHER_DISABLE_THRESHOLD: blankAsAbsent(z.coerce.number().int().positive().optional()),
  ANOMALY_STUDENT_DISABLE_THRESHOLD: blankAsAbsent(z.coerce.number().int().positive().optional()),
  ANOMALY_FAILED_NOTIFICATIONS_THRESHOLD: blankAsAbsent(
    z.coerce.number().int().positive().optional(),
  ),
  ANOMALY_FAILED_PAYMENTS_THRESHOLD: blankAsAbsent(z.coerce.number().int().positive().optional()),
  ANOMALY_PUSH_FAILURE_THRESHOLD: blankAsAbsent(z.coerce.number().int().positive().optional()),
  // Web Push (browser transport of the `push` channel).
  // VAPID keypair identifying this application server to every browser push
  // service; generate once with `npx web-push generate-vapid-keys` and keep the
  // pair stable — rotating the PUBLIC key silently invalidates every existing
  // browser subscription, because the key is baked into the subscription the
  // browser minted. Read straight from process.env by
  // lib/notifications/web-push.ts, so a send never depends on the whole
  // schema validating.
  // Both absent = web push is simply unavailable (the UI hides itself and
  // the dispatcher skips the transport); no error, no partial state.
  VAPID_PUBLIC_KEY: blankAsAbsent(z.string().min(1).optional()),
  VAPID_PRIVATE_KEY: blankAsAbsent(z.string().min(1).optional()),
  // `mailto:` or https URL the push service can use to contact us about a
  // misbehaving application server. Required by the VAPID spec.
  VAPID_SUBJECT: blankAsAbsent(z.string().min(1).optional()),
  // Lesson-insights transcription (Phase B, D-19). All optional and read
  // straight from process.env by the transcription layer (so availability never
  // depends on the whole schema validating); declared here for documentation.
  // DEEPGRAM_API_KEY / ASSEMBLYAI_API_KEY pick the ASR vendor (only Deepgram has
  // an adapter today). LESSON_INSIGHTS_TRANSCRIPTION_ENABLED is the kill-switch:
  // the pipeline stays dormant (Phase A log-only) until it is on AND a vendor is
  // configured.
  DEEPGRAM_API_KEY: blankAsAbsent(z.string().min(1).optional()),
  ASSEMBLYAI_API_KEY: blankAsAbsent(z.string().min(1).optional()),
  LESSON_INSIGHTS_TRANSCRIPTION_ENABLED: blankAsAbsent(z.string().min(1).optional()),
  // Live in-class captions (D-27): real-time Spanish→English subtitles. Reuses
  // DEEPGRAM_API_KEY (streaming ASR) + ANTHROPIC_API_KEY (translation), so it
  // adds no new vendor. LIVE_CAPTIONS_ENABLED is the kill-switch — the teacher's
  // toggle stays hidden until it is on AND both keys are present (lib/captions/
  // config.ts reads these straight from process.env). CAPTION_TRANSLATION_MODEL
  // optionally overrides the (fast, cheap) translation model; defaults to Haiku.
  LIVE_CAPTIONS_ENABLED: blankAsAbsent(z.string().min(1).optional()),
  CAPTION_TRANSLATION_MODEL: blankAsAbsent(z.string().min(1).optional()),
  // Shared secret authenticating the self-hosted LiveKit captions Agent
  // (packages/livekit-captions-agent, docs/architecture/
  // LIVEKIT_CAPTIONS_AUDIT.md) when it calls back into
  // /api/internal/captions/* for room config (consent/language/entitlement)
  // and translation — a trusted server-to-server caller, not a browser
  // session, so it authenticates via this header secret instead. Absent =
  // those routes 404 (dark by default); must be set in both preview and
  // production.
  CAPTIONS_AGENT_SHARED_SECRET: blankAsAbsent(z.string().min(1).optional()),
  // Class recording (LiveKit Egress). CLASS_RECORDING_ENABLED is the kill-switch
  // — OFF by default — so the teacher's Record control stays hidden and the
  // start is refused until it is on AND egress storage is configured
  // (LIVEKIT_EGRESS_S3_*; lib/video/recording.ts reads this straight from
  // process.env). Recording a live lesson carries the same consent weight as
  // captioning it (D-21/D-22), hence a flag rather than "on because storage exists".
  CLASS_RECORDING_ENABLED: blankAsAbsent(z.string().min(1).optional()),
  // Lesson-insights pronunciation (Phase D, D-19). Azure AI Speech scores the
  // student audio inside the B pipeline; same dormant-until-configured pattern,
  // read straight from process.env. AZURE_SPEECH_KEY/REGION select the vendor;
  // LESSON_INSIGHTS_PRONUNCIATION_ENABLED is the kill-switch. NB this sends voice
  // to a SECOND vendor — confirm the D-21 legal coverage extends to it first.
  AZURE_SPEECH_KEY: blankAsAbsent(z.string().min(1).optional()),
  AZURE_SPEECH_REGION: blankAsAbsent(z.string().min(1).optional()),
  LESSON_INSIGHTS_PRONUNCIATION_ENABLED: blankAsAbsent(z.string().min(1).optional()),
  // Observability (Slice 7a). Both optional — missing → no-op clients so
  // dev + tests run without creds. Production deploys set both via Vercel
  // env. SENTRY_DSN drives server-side Sentry; NEXT_PUBLIC_SENTRY_DSN is
  // exposed to the browser bundle. POSTHOG_KEY drives the server-side
  // event pipeline (server-side analytics capture — ad-blocker-resistant). Session replay needs
  // posthog-js in the browser, which uses the NEXT_PUBLIC_POSTHOG_* keys
  // from the client schema below.
  SENTRY_DSN: blankAsAbsent(z.string().min(1).optional()),
  POSTHOG_KEY: blankAsAbsent(z.string().min(1).optional()),
  POSTHOG_HOST: blankAsAbsent(z.string().url().optional()),
  // Optional personal API key (phx_*) enabling server-side feature-flag
  // LOCAL evaluation in posthog-node — flags resolve from a cached
  // definition instead of a network round-trip per check. Missing → the
  // node client evaluates flags remotely (still works, just slower).
  POSTHOG_PERSONAL_API_KEY: blankAsAbsent(z.string().min(1).optional()),
  // The numeric project id, which every PostHog dashboard URL carries. It was
  // a constant in lib/uat/posthog-check.ts until D-158: not a secret, and an
  // account identifier all the same, so it is configuration now. Optional —
  // absent means the /admin/uat PostHog check reports itself unconfigured
  // rather than failing the page.
  POSTHOG_PROJECT_ID: blankAsAbsent(z.string().min(1).optional()),
  // Slice 7b — Vitest integration project (`pnpm test:integration`).
  // Points at a dedicated Postgres (local docker-compose.test.yml on
  // 5433, or a Supabase preview project). Missing → integration suite
  // skips with a clear log; never read by production code.
  TEST_DATABASE_URL: blankAsAbsent(z.string().url().optional()),
  // E2E only. Lets the in-memory Stripe stub be served even in a NODE_ENV=
  // production build — which is how the hermetic E2E gate runs the app
  // (`next build` + `next start`, for fast deterministic hydration) without
  // real Stripe creds. NEVER set in a real deployment: with it unset, prod
  // still fails closed (see getStripeClient + allowStripeStub). Read only by
  // allowStripeStub(); production code paths never branch on it otherwise.
  E2E_STRIPE_STUB: blankAsAbsent(z.string().optional()),
  // E2E only. Skips the sign-in OTP rate limiters (requestSignInCodeAction).
  // The hermetic E2E gate runs every spec against ONE `next start` process
  // with ONE in-memory rate-limit bucket (no Upstash creds), and several
  // spec files legitimately resend a code for the same seeded teacher email
  // within minutes — something no real user does, but which trips the
  // per-email limiter and leaves the sign-in form stuck on its error state
  // instead of showing the code field, which Playwright then reports as a
  // 240s timeout.
  //
  // ⚠️ This IS read by a production code path — `requestSignInCodeAction` and
  // `verifySignInCodeAction` branch on `allowRateLimitBypass()` in the same
  // module that serves real users. Setting it in a deployed environment turns
  // the sign-in and code-verification limiters off for everyone. Nothing in
  // this repository prevents that; keeping it unset outside the E2E harness is
  // the only control.
  E2E_RATE_LIMIT_BYPASS: blankAsAbsent(z.string().optional()),
  // Super-user gate. Comma-separated emails allowed to reach `/admin`.
  // Merged at runtime with `BUILTIN_SUPERUSERS`. Empty + no builtin →
  // admin panel is closed to everyone.
  SUPERUSER_EMAILS: blankAsAbsent(z.string().optional()),
  // Rate limiter backend (docs/security.md). When both keys
  // are set, the limiter routes to Upstash Redis instead of the
  // single-region in-memory bucket. Recommended for multi-region
  // production deploys; safe to leave blank in dev / single-region.
  UPSTASH_REDIS_REST_URL: blankAsAbsent(z.string().url().optional()),
  UPSTASH_REDIS_REST_TOKEN: blankAsAbsent(z.string().min(1).optional()),
  // Master key for field-level encryption (docs/security.md).
  // 32 random bytes, base64-encoded. Generate via
  //   `openssl rand -base64 32`
  // and store in Supabase Vault. When unset, the encryption helpers
  // return null and callers store the value in plaintext — this is the
  // pre-rollout state. Setting the key enables encryption for newly
  // written rows; existing rows are migrated by an Inngest backfill.
  FIELD_ENCRYPTION_KEY: blankAsAbsent(z.string().min(1).optional()),
  // Cutover flag for field-level encryption (docs/security.md).
  // Set to "1"/"true" in the SAME release that swaps the `phoneE164`
  // readers/writers to ciphertext. While unset (today, pre-rollout) the helpers
  // return null → plaintext and boot is unaffected. Once set, production boot
  // HARD-REQUIRES a valid FIELD_ENCRYPTION_KEY (see assertProductionCredentials),
  // so a missing key can never silently fall back to persisting PII in plaintext.
  FIELD_ENCRYPTION_REQUIRED: blankAsAbsent(z.string().min(1).optional()),
  // Wise automated reconciliation (poll-wise-statements cron). The API
  // credentials are PER-TEACHER (stored encrypted on the Teacher row), and so
  // is the balance currency to reconcile (Teacher.pricingCurrency, D-64) — this
  // is the only platform-wide knob left, optional:
  //   * WISE_API_BASE: override for sandbox
  //     (https://api.sandbox.transferwise.tech). Defaults to production.
  WISE_API_BASE: blankAsAbsent(z.string().url().optional()),
  // Google Calendar busy-import (Phase 3 calendar). OAuth client credentials
  // for the read-only Calendar connection teachers opt into; the poller reads
  // their external "busy" times so the slot generator won't offer a slot over
  // a personal event. Both optional — when absent the whole feature is dormant
  // (the Connect button hides, the cron no-ops), matching the Stripe
  // optional-credential pattern. Enforced at runtime by hasGoogleCalendarCreds().
  // The redirect URI is derived as `${APP_URL}/api/calendar/google/callback`
  // and must be registered on the OAuth client.
  GOOGLE_OAUTH_CLIENT_ID: blankAsAbsent(z.string().min(1).optional()),
  GOOGLE_OAUTH_CLIENT_SECRET: blankAsAbsent(z.string().min(1).optional()),
  // Google Sign-In for login (better-auth socialProviders.google) — SEPARATE
  // from the Calendar busy-import OAuth client above (GOOGLE_OAUTH_*): different
  // purpose, different scopes, different consent screen, so a change to one
  // never perturbs the other. Optional, matching the Calendar/Stripe optional-
  // credential pattern: when either is unset the "Continuar con Google" button
  // is hidden (hasGoogleAuthCreds() false) and the better-auth social endpoints
  // stay unregistered, so email-OTP remains the only rail. The OAuth client's
  // authorized redirect URI must be `${APP_URL}/api/auth/callback/google`.
  GOOGLE_CLIENT_ID: blankAsAbsent(z.string().min(1).optional()),
  GOOGLE_CLIENT_SECRET: blankAsAbsent(z.string().min(1).optional()),
});

const clientSchema = z.object({
  NEXT_PUBLIC_SENTRY_DSN: blankAsAbsent(z.string().min(1).optional()),
  // Posthog browser SDK (session replay on the public booking funnel).
  // Optional; missing → posthog-js is never initialized and the funnel
  // ships without recording. Ad-blockers may drop posthog-js even when
  // configured — that's the price of client-side capture vs server-side analytics capture
  // server-side events, which remain unaffected.
  NEXT_PUBLIC_POSTHOG_KEY: blankAsAbsent(z.string().min(1).optional()),
  NEXT_PUBLIC_POSTHOG_HOST: blankAsAbsent(z.string().url().optional()),
  // Which PostHog Cloud region the clients point at (reverse-proxy
  // destinations + ui_host). Default US; `eu` once the EU project exists.
  // See D-48 — the project itself is dashboard-pinned, so this only aims the
  // clients, it does not move data.
  NEXT_PUBLIC_POSTHOG_REGION: blankAsAbsent(z.enum(["us", "eu"]).optional()),
  // Public (pk_live_*/pk_test_*) — safe to expose to the browser, loaded by
  // @stripe/stripe-js (Embedded Checkout) and @stripe/connect-js (embedded
  // Connect components). Not a secret; missing → both stay on their
  // hosted-redirect fallback rather than erroring.
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: blankAsAbsent(z.string().min(1).optional()),
});

type ServerEnv = z.infer<typeof serverSchema>;
type ClientEnv = z.infer<typeof clientSchema>;

// Every env var this module recognizes, derived from the schemas so the
// lists never drift. Tests use these to scrub ambient values before
// patching process.env — without it, real credentials present in a CI/
// build environment (e.g. Vercel) leak into cases that assert a var is
// absent. Not read by app code.
export const SERVER_ENV_KEYS = Object.keys(serverSchema.shape) as (keyof ServerEnv)[];
export const CLIENT_ENV_KEYS = Object.keys(clientSchema.shape) as (keyof ClientEnv)[];

let cachedServer: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cachedServer) return cachedServer;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid server environment:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  cachedServer = parsed.data;
  return cachedServer;
}

export function hasStripeCreds(): boolean {
  const env = serverEnv();
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

// E2E escape hatch: serve the in-memory Stripe stub even under NODE_ENV=
// production, which is how the hermetic E2E gate runs the app (a prod build, so
// hydration is fast and deterministic instead of `next dev` cold-compiling per
// route). Opt-in via E2E_STRIPE_STUB=1; unset everywhere else, so a real
// production deploy still fails closed (getStripeClient throws) — the stub is
// never silently served in front of paying users. The flag is the only thing
// that relaxes that, and it lives only in the E2E workflow env.
export function allowStripeStub(): boolean {
  const v = serverEnv().E2E_STRIPE_STUB;
  return v === "1" || v === "true";
}

// E2E escape hatch: skip the sign-in OTP rate limiters. See the
// E2E_RATE_LIMIT_BYPASS schema comment above for why the E2E gate needs
// this. Never set in a real deployment.
//
// Reads process.env directly rather than via serverEnv() — this is called
// from the hot path of every sign-in attempt (requestSignInCodeAction), and
// serverEnv() throws in any environment missing the full required var set
// (e.g. unit tests, which mock @/lib/rate-limit but not @/lib/env). Default
// false on any ambiguity, so the limiters stay on unless explicitly opted out.
export function allowRateLimitBypass(): boolean {
  const v = process.env.E2E_RATE_LIMIT_BYPASS;
  return v === "1" || v === "true";
}

// Subscription billing is available only when the platform Stripe key, all
// three Price IDs, and the billing webhook secret are present. When false the
// paywall is hidden and every teacher stays on Free/trial (dev still boots).
// Mirrors the Stripe-optional / warn-only treatment.
export function hasBillingCreds(): boolean {
  const env = serverEnv();
  return Boolean(
    env.STRIPE_SECRET_KEY &&
    env.STRIPE_BILLING_WEBHOOK_SECRET &&
    env.STRIPE_PRICE_MONTHLY &&
    env.STRIPE_PRICE_ANNUAL &&
    env.STRIPE_PRICE_FOUNDING,
  );
}

// The configured Stripe Billing Price IDs, for plan↔price resolution.
export function billingPriceIds(): { monthly?: string; annual?: string; founding?: string } {
  const env = serverEnv();
  return {
    monthly: env.STRIPE_PRICE_MONTHLY,
    annual: env.STRIPE_PRICE_ANNUAL,
    founding: env.STRIPE_PRICE_FOUNDING,
  };
}

export function hasResendCreds(): boolean {
  return Boolean(serverEnv().RESEND_API_KEY);
}

export function hasSesCreds(): boolean {
  const env = serverEnv();
  return Boolean(env.SES_REGION && env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY);
}

// Google Calendar busy-import is available only when both OAuth credentials are
// configured. When false the feature stays dormant (Connect button hidden, the
// sync cron no-ops), mirroring the Stripe optional-credential treatment.
export function hasGoogleCalendarCreds(): boolean {
  const env = serverEnv();
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

// Google Sign-In (login) is available only when both social OAuth credentials
// are configured. When false the "Continuar con Google" button is hidden and
// the better-auth google social provider is left unregistered, so email-OTP is
// the sole rail — mirroring the Calendar/Stripe optional-credential treatment.
// Distinct from hasGoogleCalendarCreds() (the busy-import client).
export function hasGoogleAuthCreds(): boolean {
  const env = serverEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function hasInngestCreds(): boolean {
  const env = serverEnv();
  return Boolean(env.INNGEST_EVENT_KEY && env.INNGEST_SIGNING_KEY);
}

// Which background-jobs backend is active
// (docs/architecture/overview.md). Defaults to "inngest" on any unset/
// unrecognized value so the flag can only ever opt IN to pg-boss, never
// silently fall onto it.
export function jobsBackend(): "inngest" | "pgboss" {
  return serverEnv().JOBS_BACKEND === "pgboss" ? "pgboss" : "inngest";
}

// True once the field-encryption cutover flag is flipped (see field-level encryption). Gates the
// hard boot requirement for FIELD_ENCRYPTION_KEY in assertProductionCredentials.
export function fieldEncryptionRequired(): boolean {
  const v = serverEnv().FIELD_ENCRYPTION_REQUIRED;
  return v === "1" || v === "true";
}

// Decoded byte length of FIELD_ENCRYPTION_KEY, or null when unset. Lets the boot
// assertion validate the key once at startup instead of lazily at first use.
function fieldEncryptionKeyBytes(): number | null {
  const raw = serverEnv().FIELD_ENCRYPTION_KEY;
  if (!raw) return null;
  return Buffer.from(raw, "base64").length;
}

// Read + sanitize the Anthropic key from the raw environment. Every reader of
// ANTHROPIC_API_KEY (class-content compose, lesson-notes insights/brief/summary,
// live caption translation) goes through here so the fix below lives in exactly
// one place. Mirrors deepgramApiKey() (lib/captions/config.ts): some env-var UIs
// make it easy to accidentally paste a value WITH its surrounding quotes, and
// Anthropic's SDK then rejects the malformed key outright — surfacing as an
// opaque "error" from every translate/compose call rather than a clear
// misconfiguration message.
export function anthropicApiKey(): string | undefined {
  const raw = serverEnv().ANTHROPIC_API_KEY?.trim();
  if (!raw) return undefined;
  const first = raw[0];
  const last = raw[raw.length - 1];
  const quoted =
    raw.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"));
  return quoted ? raw.slice(1, -1).trim() : raw;
}

// AI class-content compose is available only when the platform Anthropic key is
// set. When false the "Generate with AI" path is hidden/blocked and teachers
// still author content by hand — mirroring the Stripe optional-credential
// pattern (the feature degrades, it never breaks the page).
export function hasAnthropicCreds(): boolean {
  return Boolean(anthropicApiKey());
}

// The Claude model used for class-content compose. Overridable via env;
// defaults to Sonnet 5 (D-87). Central so the action and tests never hardcode
// it.
//
// ⚠️ MUST stay on a model that supports `output_config.effort`. Every call site
// in lib/ai/anthropic.ts (generateMaterial, refineMaterial,
// generatePodcastScript, generateMaterialStream) passes
// `output_config: { effort: "medium" }`, which is REJECTED WITH A 400 on
// pre-4.6 models — including claude-haiku-4-5. That is why the four short,
// structured lesson-notes/intro-coach constants could go to Haiku for D-87 and
// this one could not. The invariant is pinned by a test in
// tests/lib/env.test.ts; a same-tier, cheaper model is fine as long as it
// supports effort.
export function anthropicModel(): string {
  return serverEnv().ANTHROPIC_MODEL ?? "claude-sonnet-5";
}

// The Claude model used for live caption translation (D-27). A hot path — one
// call per finished utterance — so the intent has always been fast, cheap
// Haiku; as of D-87 the four short lesson-notes/intro-coach surfaces are Haiku
// too, so this is no longer the odd one out (it kept its own env override).
// Class-content compose stays on Sonnet 5 — it is long-form and passes
// `effort`, which Haiku does not support. Was TEMPORARILY
// defaulted to claude-opus-4-8 (2026-07-12) after the dated snapshot
// claude-haiku-4-5-20251001 502'd for lacking model access; reverted to the
// undated alias claude-haiku-4-5 once Haiku access was confirmed enabled.
// Overridable via env either way.
export function captionTranslationModel(): string {
  return serverEnv().CAPTION_TRANSLATION_MODEL ?? "claude-haiku-4-5";
}

// ElevenLabs text-to-speech, for material podcast generation. Sanitized the
// same way as anthropicApiKey() — env-var UIs make it easy to paste a value
// with surrounding quotes, which the API then rejects opaquely.
export function elevenLabsApiKey(): string | undefined {
  const raw = serverEnv().ELEVENLABS_API_KEY?.trim();
  if (!raw) return undefined;
  const first = raw[0];
  const last = raw[raw.length - 1];
  const quoted =
    raw.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"));
  return quoted ? raw.slice(1, -1).trim() : raw;
}

// Podcast generation is available only when the platform ElevenLabs key is set.
// When false the "Generate podcast" action is hidden/blocked — mirroring the
// Anthropic/Stripe optional-credential pattern (degrades, never breaks the page).
export function hasElevenLabsCreds(): boolean {
  return Boolean(elevenLabsApiKey());
}

// The ElevenLabs voice used to narrate podcasts. Overridable via env; defaults
// to "Rachel", a widely-available stock voice. Central so callers/tests never
// hardcode an id.
export function elevenLabsVoiceId(): string {
  return serverEnv().ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
}

// The ElevenLabs model used for synthesis. Defaults to the multilingual model
// because scripts are es-MX (default locale) and other taught languages, not
// only English. Overridable via env.
export function elevenLabsModelId(): string {
  return serverEnv().ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
}

// Google Cloud Text-to-Speech key — sanitized the same way as the others (some
// env-var UIs paste surrounding quotes, which the API then rejects opaquely).
export function googleTtsApiKey(): string | undefined {
  const raw = serverEnv().GOOGLE_TTS_API_KEY?.trim();
  if (!raw) return undefined;
  const first = raw[0];
  const last = raw[raw.length - 1];
  const quoted =
    raw.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"));
  return quoted ? raw.slice(1, -1).trim() : raw;
}

// True when the Google TTS rail is configured (the preferred podcast rail).
export function hasGoogleTtsCreds(): boolean {
  return Boolean(googleTtsApiKey());
}

// --- Gemini image generation (social previews, D-123/D-127) -----------------

// Same de-quoting defence as anthropicApiKey(): a value pasted into a
// secrets manager WITH its surrounding quotes otherwise reaches Google
// verbatim and fails as an opaque auth error rather than a clear
// misconfiguration.
function dequote(raw: string): string {
  const first = raw[0];
  const last = raw[raw.length - 1];
  const quoted =
    raw.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"));
  return quoted ? raw.slice(1, -1).trim() : raw;
}

/** The service account credential Vertex AI calls sign with. `undefined`
 * when unset, malformed base64, or the decoded JSON is missing either
 * field — any of which must degrade to "AI generation hidden", never a
 * boot-time crash, per the same D-114 two-condition shape every other AI
 * capability here uses. */
export function geminiVertexServiceAccount():
  { clientEmail: string; privateKey: string } | undefined {
  const raw = serverEnv().GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64?.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(dequote(raw), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { client_email, private_key } = parsed as Record<string, unknown>;
  if (typeof client_email !== "string" || typeof private_key !== "string") return undefined;
  if (!client_email || !private_key) return undefined;
  return { clientEmail: client_email, privateKey: private_key };
}

export function geminiVertexProjectId(): string | undefined {
  const raw = serverEnv().GEMINI_VERTEX_PROJECT_ID?.trim();
  return raw ? dequote(raw) : undefined;
}

// Gemini image models are only published in a handful of Vertex locations
// (confirmed empirically: `global` serves gemini-3.1-flash-image where
// `us-central1` 404s) — default to the one that works rather than making
// every environment discover this the same way.
export function geminiVertexLocation(): string {
  return serverEnv().GEMINI_VERTEX_LOCATION ?? "global";
}

export function hasGeminiImageCreds(): boolean {
  return Boolean(geminiVertexServiceAccount() && geminiVertexProjectId());
}

// The image model used for social previews. Overridable via env so a cheaper
// or newer model is an env change, not a deploy. Defaults to the Flash image
// tier: it is the cheapest credible quality for this job, and the axis the
// pricier tiers win on (rendering text INSIDE the image) is one we design away
// entirely — SpiralClass renders every character itself (D-123).
export function geminiImageModel(): string {
  return serverEnv().GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image";
}

// The single gate the social-preview UI and the generate action read.
//
// The two-condition shape every other AI capability here uses (D-114): a
// vendor is configured AND an explicit enablement flag is on. A credential
// appearing in the secrets manager must not, by itself, switch on a surface
// that spends money per click and puts model output on a teacher's public
// posts. Off/unset = the generate control is hidden and the server refuses;
// already-generated previews keep serving, because nothing deletes them.
export function socialPreviewAiEnabled(): boolean {
  const raw = process.env.SOCIAL_PREVIEW_AI_ENABLED?.trim().toLowerCase();
  const flagOn = raw === "1" || raw === "true" || raw === "on";
  return flagOn && hasGeminiImageCreds();
}

// Optional overrides for the Google voice + BCP-47 language code; when unset
// google-tts.ts picks a sensible Neural2 default from the narration language.
export function googleTtsVoice(): string | undefined {
  return serverEnv().GOOGLE_TTS_VOICE;
}
export function googleTtsLanguageCode(): string | undefined {
  return serverEnv().GOOGLE_TTS_LANGUAGE_CODE;
}

// Podcast TTS credentials are present when EITHER rail is configured: Google
// (preferred, cheap, datacenter-friendly) or ElevenLabs (fallback). Adding or
// removing a rail changes only this function.
//
// Credential detection ONLY — call podcastsEnabled() to decide whether the
// feature is offered.
export function hasTtsCreds(): boolean {
  return hasGoogleTtsCreds() || hasElevenLabsCreds();
}

// The single gate the podcast UI and the request action read (D-114).
//
// Same two-condition shape as every other AI capability here — a vendor is
// configured AND an explicit enablement flag is on — for the same reason
// (lib/captions/config.ts, lib/transcription/config.ts, lib/pronunciation/
// config.ts all document it): a credential appearing in Infisical must not, by
// itself, switch a student-facing AI feature on. Podcasts were the one AI
// surface with no such flag, so the only way to turn them off was to pull a
// secret — an unreviewable change with no diff. Off/unset = the "Generate
// podcast" action is hidden and the server refuses the request; already-
// generated podcasts keep playing, since nothing deletes them.
//
// Read straight from process.env (like the config modules above) so an
// availability check never depends on the whole env schema validating.
export function podcastsEnabled(): boolean {
  const raw = process.env.MATERIAL_PODCASTS_ENABLED?.trim().toLowerCase();
  const flagOn = raw === "1" || raw === "true" || raw === "on";
  return flagOn && hasTtsCreds();
}

// True only for the real *production* deployment. The preview deployment builds
// with NODE_ENV "production" too, but must read as non-prod here — see
// assertProductionCredentials below and the mint-otp test route, both of which
// gate real behavior on this. We decide "is this prod" from APP_URL, a
// first-class app var present at both build and runtime: the preview host
// (`preview.spiralclass.com`) reads as non-prod, the canonical apex as prod.
// (Pre-D-89 this preferred Vercel's VERCEL_ENV signal; Vercel is gone, so
// APP_URL is now the sole source.)
export function isProductionDeployment(): boolean {
  const env = serverEnv();
  if (env.NODE_ENV !== "production") return false;
  return !env.APP_URL.includes("preview");
}

// True only for the deployed PREVIEW app — deliberately NOT the inverse of
// isProductionDeployment(), which also reads false for local dev and tests.
// Callers here want "this is the preview deploy specifically", so that turning
// something off in preview doesn't silently turn it off on a laptop too.
//
// Used to keep the cron fleet from running in preview (lib/inngest/functions,
// lib/jobs/boss): Neon's Free plan gives each project 100 CU-hours/month and
// suspends the compute for the rest of the billing period once that's spent,
// and its scale-to-zero timer is fixed at 5 minutes. One DB touch therefore
// buys 5 minutes of billed compute, so a cron fleet ticking every 5-15 min
// pins the database awake ~24/7. Preview has no real users to remind, sweep,
// or reconcile for, so that spend bought nothing.
export function isPreviewDeployment(): boolean {
  const env = serverEnv();
  if (env.NODE_ENV !== "production") return false;
  return env.APP_URL.includes("preview");
}

export function assertProductionCredentials(): void {
  const env = serverEnv();
  if (env.NODE_ENV !== "production") return;
  if (!isProductionDeployment()) return;
  // Hard requirements — the app cannot serve traffic without these.
  // Stripe is intentionally NOT here: it gracefully degrades (Stripe UI
  // hides) and many alpha deploys start Wise-only and add Stripe later.
  const missing: string[] = [];
  if (!hasResendCreds() && !hasSesCreds()) {
    missing.push("Email (SES_REGION/SES_ACCESS_KEY_ID/SES_SECRET_ACCESS_KEY or RESEND_API_KEY)");
  }
  if (!hasInngestCreds()) missing.push("Inngest (INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY)");
  if (!env.SENTRY_DSN) missing.push("Sentry (SENTRY_DSN)");
  if (!env.POSTHOG_KEY || !env.POSTHOG_HOST) missing.push("PostHog (POSTHOG_KEY, POSTHOG_HOST)");
  if (missing.length > 0) {
    throw new Error(
      `Missing required production credentials:\n${missing.map((m) => `  - ${m}`).join("\n")}`,
    );
  }
  // Field-level encryption. Two boot-time guards:
  //   1. If a key is present, validate it decodes to 32 bytes — fail fast at boot
  //      instead of throwing lazily on the first encrypt/decrypt in a hot path.
  //   2. If the cutover flag (FIELD_ENCRYPTION_REQUIRED) is set, the key MUST be
  //      present — refuse to boot rather than silently persist PII as plaintext.
  const keyBytes = fieldEncryptionKeyBytes();
  if (keyBytes !== null && keyBytes !== 32) {
    throw new Error(`FIELD_ENCRYPTION_KEY must decode to 32 bytes, got ${keyBytes}`);
  }
  if (fieldEncryptionRequired() && keyBytes === null) {
    throw new Error(
      "FIELD_ENCRYPTION_REQUIRED is set but FIELD_ENCRYPTION_KEY is missing — refusing to boot " +
        "and persist PII as plaintext. Set the key or clear the flag.",
    );
  }
  // Optional integrations — warn the operator so it's discoverable from
  // the function logs that the app started in a degraded mode.
  if (!hasStripeCreds()) {
    log.warn(
      "Stripe creds missing — Stripe Connect onboarding hidden; teachers use Wise-only mode.",
    );
  }
  // The rate limiter degrades to an in-memory token bucket without Upstash
  // (lib/rate-limit.ts). That is per-machine and it resets on a cold start, so
  // in production the effective limit on sign-in, sign-up and code entry is the
  // configured number TIMES the number of live machines, and again after every
  // scale event. Not fatal — better-auth caps an emailed code at three attempts
  // regardless — but it is the kind of degradation that is invisible until
  // somebody goes looking, so say it at boot.
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    log.warn("Upstash not configured — rate limits are per-machine and reset on cold start.");
  }
}

// Always-on super-user entries. Empty by default — operators must opt in
// via the `SUPERUSER_EMAILS` env var or by adding entries here.
export const BUILTIN_SUPERUSERS: ReadonlySet<string> = new Set([]);

export function superuserAllowlist(): ReadonlySet<string> {
  const env = serverEnv();
  const raw = env.SUPERUSER_EMAILS ?? "";
  const fromEnv = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set<string>([...BUILTIN_SUPERUSERS, ...fromEnv]);
}

export function isSuperuser(email: string | null | undefined): boolean {
  if (!email) return false;
  return superuserAllowlist().has(email.toLowerCase());
}

export function clientEnv(): ClientEnv {
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    NEXT_PUBLIC_POSTHOG_REGION: process.env.NEXT_PUBLIC_POSTHOG_REGION,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid client environment:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  return parsed.data;
}

// Gates both Embedded Checkout (Payment Element) and embedded Connect
// components: the SERVER only offers the embedded/inline flow when the
// browser will actually be able to load Stripe.js/Connect.js against a real
// publishable key. Without this, an env missing
// NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (today's dev/E2E default) would hand
// the client a client_secret it can't mount anything with — same
// Stripe-optional degrade-gracefully pattern as every other vendor in this
// file.
export function hasStripeEmbeddedCheckout(): boolean {
  return Boolean(clientEnv().NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
}
