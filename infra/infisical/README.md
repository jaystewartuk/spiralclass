# Infisical — Fly.io deploy secrets

Secrets manager for everything the Fly app (`agendaprofe`, currently serving
**preview**) needs at runtime, **except** the R2
credentials, which stay Tofu-owned (`infra/cloudflare-r2/`, D-65) — don't
move those here.

Replaces a plaintext `.env.fly.local` that was being pasted into `fly
secrets set` by hand. See `docs/decisions/D-66.md` for why.

## Adding a new script that needs a secret

Source `with-secret.sh` instead of re-implementing the `PROJECT_ID` lookup +
`secrets get --output dotenv` + safe-export dance — every script that used
to duplicate that boilerplate now just does:

```bash
source "$REPO_ROOT/infra/infisical/with-secret.sh"
infisical_export_secrets LIVEKIT_API_SECRET       # env=preview (default)
infisical_export_secrets --env production STRIPE_SECRET_KEY
```

It resolves `.infisical.json` relative to _itself_, so **your script does
NOT need to live in this directory** to use it — put it wherever its actual
task domain suggests (e.g. `docs/deployment/livekit-activity.sh` sits with the rest
of the LiveKit-box runbook, not here, even though it pulls
`LIVEKIT_API_SECRET`). Reserve `infra/infisical/` itself for scripts that
are genuinely _about_ Infisical/secrets management (`push-fly-secrets.sh`,
this helper) rather than task scripts that merely consume one secret.

Every script that pulls `DATABASE_URL`/etc. is on the helper now —
`seed-preview.sh` is what is left of that list. The three `maestro-test*.sh`
wrappers were on it too, and went with the app they tested. The gotcha they
documented is worth
keeping in mind for any future caller: `infisical_export_secrets` _exports_ the
secret rather than handing back the raw `--output dotenv` string, so anything
that needs `KEY=VALUE` shape has to rebuild it.

Nothing left in `infra/infisical/` duplicates the old boilerplate —
`push-fly-secrets.sh` is the one remaining script here, and it's genuinely
about Infisical (importing a whole environment into `fly secrets`), not a
task script that merely consumes one secret.

## Account setup (cloud free tier)

1. Sign up at [infisical.com](https://infisical.com) (free tier — unlimited
   secrets/environments, fine for a solo project; see D-66 for why not
   self-hosted).
2. Create one project: **SpiralClass**.
3. Repurpose the default `dev`/`staging`/`prod` trio Infisical creates into
   three slugs: `preview`, `production`, and `infra` (Infisical lets you
   rename an environment's slug in Project Settings → Environments).
   Production stays empty until the Fly promotion actually happens; **do
   not** wire it into any script or CI until then. `infra` holds the Tofu
   operator credentials — see "The `infra` environment" below.
4. Install the CLI (`brew install infisical/get-cli/infisical` or see
   [docs](https://infisical.com/docs/cli/overview)), then `infisical login`.
5. From this directory (`infra/infisical/`), run `infisical init` once and
   pick the project — or copy `.infisical.json.example` over
   `.infisical.json` and fill in the id. It is kept here on purpose (not
   relocated to a shared top-level spot like `infra/backend.hcl`)
   because `push-fly-secrets.sh`/`seed-preview.sh` in this directory already
   assume it lives right here (`seed-preview.sh` even reads it directly via
   Node), and every other module points at it via
   `--project-config-dir=../infisical` instead of needing its own copy; see
   `infra/README.md`.

   ⚠️ **Do not commit it** — [D-158](../../docs/decisions/D-158.md) reverses
   the earlier convenience on this one point.
   It holds a project id, which is an account identifier, and this repository
   is public. `.gitignore` covers it and `.infisical.json.example` is the
   committed shape. **A fresh clone has no link file**, which is deliberate:
   every consumer fails with a message naming this step rather than reaching
   for a default that happens to work.

## The `infra` environment (Tofu operator credentials)

Separate from the app-runtime `preview`/`production` environments above: the
`infra` environment holds the secrets needed to **run the OpenTofu
modules** under `infra/` (create buckets, read/write the R2 state bucket,
provision the Oracle box) — credentials you'd otherwise `export`
by hand every session. They are **not** app secrets; the Fly app never
reads them.

| Key                                   | Read by                                                                                                                                                                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                | the `cloudflare` provider                                                                                                                                              | account-scoped provider token (`infra/cloudflare`, `infra/cloudflare-r2`)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AWS_ACCESS_KEY_ID`                   | OpenTofu's `s3` state backend                                                                                                                                          | `agendaprofe-tofu-state` R2 access key id                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AWS_SECRET_ACCESS_KEY`               | OpenTofu's `s3` state backend                                                                                                                                          | `agendaprofe-tofu-state` R2 secret                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `TF_VAR_tailscale_authkey_oracle`     | hand-copied into the box's `.env`/config during a rebuild (D-139 — was a Tofu `TF_VAR_*` binding until `infra/oracle-runner` was deleted)                              | Tailscale auth key, from Tailscale admin console → Settings → Keys. **Reusable ON, Ephemeral OFF** (long-lived box, never routinely destroyed — ephemeral would risk Tailscale pruning it after ~30-60min offline, which a slow reboot could exceed). See the rotation runbook (kept privately — see `docs/security.md`)                                                                                                                                                                                         |
| `TF_VAR_livekit_api_secret`           | hand-copied into the box's `.env` (D-139 — was a Tofu `TF_VAR_*` binding; interpolated into `livekit.yaml`/`egress.yaml`/the `captions-agent` compose service)         | LiveKit API secret — the genuinely sensitive half of the box's key pair (signs/verifies tokens). Must exactly match the app-side `LIVEKIT_API_SECRET` (this same project's `preview`/`production` environments) — see the rotation runbook (kept privately — see `docs/security.md`) for the full rotation coupling. The paired, non-secret key **id** (`LIVEKIT_API_KEY`) is deliberately NOT here — it is read straight from the committed `config/env/production.runtime.env` instead, so the id has one home |
| `TF_VAR_deepgram_api_key`             | hand-copied into the box's `.env` (D-139 — was a Tofu `TF_VAR_*` binding; the captions Agent's server-side Deepgram STT calls, D-106)                                  | Deepgram API key — console.deepgram.com → API Keys. Doesn't strictly have to equal the app-side `DEEPGRAM_API_KEY` below, but reusing the same value avoids provisioning a second key for no reason                                                                                                                                                                                                                                                                                                              |
| `TF_VAR_captions_agent_shared_secret` | hand-copied into the box's `.env` (D-139 — was a Tofu `TF_VAR_*` binding; the captions Agent's auth to `apps/web`'s `/api/internal/captions/room-config` route, D-106) | Self-generated (`openssl rand -hex 32` or equivalent). Must exactly match `CAPTIONS_AGENT_SHARED_SECRET` in this project's `production` environment (below) — a mismatch 404s the Agent's calls (the route is dark-by-default on failure, `apps/web/src/lib/captions/internal-auth.ts`)                                                                                                                                                                                                                          |
| `TF_VAR_anthropic_api_key`            | hand-copied into the box's `.env` (D-139 — was a Tofu `TF_VAR_*` binding; the captions Agent's own direct Anthropic translate call, D-106 addendum 2026-07-26)         | console.anthropic.com → Settings → API Keys. Doesn't strictly have to equal the app-side `ANTHROPIC_API_KEY` below, but reusing the same value avoids provisioning a second key for no reason                                                                                                                                                                                                                                                                                                                    |

Every key name in this table must match exactly what its consuming
provider/SDK expects — `infisical run --env=infra --` injects secrets under
their literal Infisical key name, so a differently-named secret (a provider's
own spelling of its token rather than the one its Terraform provider reads)
silently isn't picked up and the provider fails with a missing-token error, not
a helpful "wrong name" message. Confirm each key here matches the doc/README that names it before
assuming it'll just work.

Shared across the `infra/` modules: `CLOUDFLARE_API_TOKEN` by `cloudflare` +
`cloudflare-r2`, `AWS_*` (the R2 state backend) by `cloudflare-r2`. Pull them
per-command with `infisical run --env=infra -- tofu <cmd>` — off argv, out of
shell history. (`infra/database/supabase`, the one module that used raw
`SUPABASE_ACCESS_TOKEN` exports instead of this pattern, is retired —
D-89/Neon migration completed; the module was removed from the repo.)

- **The `AWS_*` names are load-bearing, not a mislabel.** OpenTofu's
  `backend "s3"` reaches R2 over the S3 API and reads credentials via the AWS
  SDK's chain, which looks for exactly `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`. Renaming them (to `R2_*`) breaks `tofu init`. The
  name is the S3 protocol, not the vendor. (This is also why `infra/aws-ses`
  uses a named AWS profile instead of the bare env vars — to avoid colliding
  with these.)
- **⚠️ Never sync this environment to Fly.** `push-fly-secrets.sh` imports a
  whole environment into `fly secrets` — it must only ever run with
  `INFISICAL_ENV=preview`/`production`. Keeping the operator creds in their
  own environment (not a folder under `preview`) is the hard guarantee they
  can't leak into the app's runtime, regardless of export/path semantics.

## Shared vs. per-environment secrets

Most of the vars below are the _same value_ in preview and production today
(Resend, Sentry, Inngest, Google OAuth client, etc.) — only a handful
actually differ per environment (`DATABASE_URL`/`DIRECT_URL`, the Stripe
keys once production gets its own Stripe account per D-58, `APP_URL`).

Infisical doesn't have automatic environment inheritance, but it does support
**secret references**: a secret's value can be `${preview.SOME_KEY}`,
resolved at fetch/export time against another environment in the same
project. Use that instead of duplicating values by hand:

1. Enter every shared secret's real value once, in `preview`.
2. In `production`, for each shared secret, set the value to a reference
   (e.g. `RESEND_API_KEY` → `${preview.RESEND_API_KEY}`) instead of
   retyping it.
3. For the handful that genuinely differ per environment, set a literal
   value directly in `production` — that overrides the reference pattern
   for just that key.

This is a manual setup step (Infisical's dashboard/CLI, not this repo) — do
it yourself rather than pasting values into chat.

```sh
infisical secrets set KEY=value --env=preview
```

⚠️ **The positional is `key=value`, not a bare key.** There is no interactive
prompt — a bare `KEY` fails with _"invalid argument format… Expected format:
key=value or key=@filepath"_. This file said otherwise until 2026-09-06 and it
was never run.

To keep a value off your shell history, use the `@filepath` form the same
error names — the path goes on argv, the value does not:

```sh
umask 077 && printf %s "$VALUE" > /tmp/v
infisical secrets set KEY=@/tmp/v --env=preview
rm -f /tmp/v
```

The dashboard works too, and for a genuine credential it is the easier of the
two.

**UNVERIFIED IN THIS SESSION:** the secret-reference syntax above is
documented Infisical behavior, not something tested live from here (no
network path to app.infisical.com in this session). Confirm a reference
actually resolves (`infisical export --env=production --format=dotenv` and
check the value came through) before relying on it — if it doesn't work as
described, fall back to duplicating the value in both environments; that's
functionally fine, just loses the "rotate once" property.

## Vars Infisical owns (names, not values)

**Before entering anything, reconcile against what's actually live — the
list below is derived from reading `env.ts`'s schema, not from the running
Fly app, and you've already added secrets by hand via `fly secrets set`
beyond what a spike-era doc anticipated.** Run:

```
fly secrets list --app agendaprofe
```

That's names only (Fly never shows values back, so it's safe to run/paste
anywhere). Treat its output as the authoritative current list — add any
name it shows that isn't below into Infisical too, and add it to this list
so the doc stops drifting from reality. If a name on Fly doesn't map to
anything in `env.ts`, it's either dead (safe to eventually retire) or read
somewhere `env.ts`'s `serverSchema` doesn't cover (e.g. read directly off
`process.env` elsewhere) — worth a quick `grep` before assuming either way.

Cross-referenced against `apps/web/src/lib/env.ts`'s `serverSchema` — a
starting point, not the ground truth. R2 vars
(`*_R2_*`, `CHAT_AUDIO_R2_*`, `LIVEKIT_EGRESS_S3_*`) are deliberately
excluded — Tofu-owned, D-65.

```
DATABASE_URL
DIRECT_URL
SESSION_SECRET
BETTER_AUTH_SECRET
ANTHROPIC_API_KEY
ELEVENLABS_API_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_BILLING_WEBHOOK_SECRET
RESEND_API_KEY
SES_ACCESS_KEY_ID
SES_SECRET_ACCESS_KEY
INNGEST_EVENT_KEY
INNGEST_SIGNING_KEY
POSTHOG_PERSONAL_API_KEY
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_CLIENT_SECRET
LIVEKIT_API_SECRET
DEEPGRAM_API_KEY
ASSEMBLYAI_API_KEY
AZURE_SPEECH_KEY
FIELD_ENCRYPTION_KEY
CAPTIONS_AGENT_SHARED_SECRET
GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
```

### Where to get each value

**Neon** (console.neon.tech — Supabase was decommissioned D-89; see
`infra/database/neon/README.md`):

- `DATABASE_URL` — project's Connection Details panel → **Pooled** connection
  string (has `-pooler` in the hostname).
- `DIRECT_URL` — same panel → **Direct** connection string (no pooler) —
  Prisma's migration engine needs this one specifically.

**Self-generated — not from any vendor dashboard:**

- `SESSION_SECRET` — `openssl rand -base64 32` (or equivalent), ≥16 chars.
- `BETTER_AUTH_SECRET` — same, but ≥32 chars (`env.ts`'s own minimum).
- `FIELD_ENCRYPTION_KEY` — `openssl rand -base64 32` exactly, per the
  comment already in `env.ts`.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — from `apps/web`, run
  `pnpm exec web-push generate-vapid-keys` (the `web-push` package is already
  a dependency there; nothing to install). ⚠️ **Generate a SEPARATE
  keypair per environment** — preview must not share production's — and
  **pick each one once**: the public key is baked into every subscription a
  browser mints, so rotating it silently invalidates all of them. Entered on
  Fly `production` 2026-09-05, ending the stretch since #833 when Web Push was
  shipped and inert; `preview` still has none, and with no key the toggle
  renders nothing and the dispatcher skips the transport. ⚠️ The private one
  is `VAPID_PRIVATE_KEY` — `web-push.ts` reads that exact name, and a
  `VAPID_PRIVATE` set by hand on 2026-09-05 left the feature just as inert as
  no key at all.
- `VAPID_SUBJECT` — a `mailto:` or `https:` URL identifying the application
  server, so a push service has someone to contact about a misbehaving one.
  Required by the VAPID spec; goes to push services, not to users.
- `CAPTIONS_AGENT_SHARED_SECRET` (D-106) — `openssl rand -hex 32` or
  equivalent. **`production` only** — the captions Agent's
  `APP_INTERNAL_BASE_URL` is hardcoded to production, so there's no
  `preview` counterpart to keep in sync. Must exactly match
  `TF_VAR_captions_agent_shared_secret` in this project's `infra`
  environment (above) — see the rotation runbook (kept privately — see `docs/security.md`).

**Stripe** (Dashboard → Developers — use **test-mode** keys for preview, per
this repo's preview convention):

- `STRIPE_SECRET_KEY` — Developers → API keys → Secret key.
- `STRIPE_WEBHOOK_SECRET` — Developers → Webhooks → the endpoint registered
  for `/api/stripe/webhook` → Signing secret.
- `STRIPE_BILLING_WEBHOOK_SECRET` — Developers → Webhooks → the **separate**
  endpoint for `/api/stripe/billing-webhook` (Stripe Billing, not Connect —
  see `CLAUDE.md`'s Subscriptions section) → its own Signing secret.

**Single-vendor API keys** (each is a plain "create an API key" flow in that
vendor's dashboard):

- `ANTHROPIC_API_KEY` — [console.anthropic.com](https://console.anthropic.com)
  → Settings → API Keys.
- `GOOGLE_TTS_API_KEY` — Google Cloud console → APIs & Services → Credentials →
  an API key restricted to the **Cloud Text-to-Speech API** (enable that API on
  the same project as Sign-In). The **preferred** material-podcast TTS rail:
  cheap pay-as-you-go with a perpetual free monthly tier, and — unlike
  ElevenLabs' free tier — not blocked when called from a datacenter IP. When set
  it wins over ElevenLabs. `GOOGLE_TTS_VOICE` / `GOOGLE_TTS_LANGUAGE_CODE` are
  non-secret overrides with per-locale defaults in `env.ts`.
- `ELEVENLABS_API_KEY` — [elevenlabs.io](https://elevenlabs.io) → Profile →
  API Keys. Fallback material-podcast TTS rail (used only when `GOOGLE_TTS_API_KEY`
  is unset); requires a **paid** ElevenLabs plan — the free tier 401s
  `detected_unusual_activity` from server IPs. Optional (podcast degrades to a
  hidden button when neither rail is set). `ELEVENLABS_VOICE_ID` /
  `ELEVENLABS_MODEL_ID` are non-secret overrides with defaults in `env.ts` —
  set them only to change the narrator voice/model, not here.
- `RESEND_API_KEY` — [resend.com](https://resend.com) dashboard → API Keys.
- `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` — AWS IAM console → the
  `agendaprofe-ses-sender` user (scoped to `ses:SendEmail`/`ses:SendRawEmail`
  only) → Security credentials → Create access key. See
  `infra/aws-ses/README.md` for the full setup (domain verification,
  sandbox exit, IAM policy). `SES_REGION`/`SES_FROM` are non-secret — they
  live in `fly.toml`, not here.
- `DEEPGRAM_API_KEY` — [console.deepgram.com](https://console.deepgram.com)
  → API Keys.
- `ASSEMBLYAI_API_KEY` — [assemblyai.com](https://www.assemblyai.com)
  dashboard → API Keys.

**Inngest** ([app.inngest.com](https://app.inngest.com) → your app → Manage):

- `INNGEST_EVENT_KEY` — Manage → Event Keys.
- `INNGEST_SIGNING_KEY` — Manage → Signing Key.

**Vertex AI (Gemini image generation, D-127)** — NOT a plain "create an API
key" flow, because Vertex has no bare-API-key auth surface:

- `GEMINI_VERTEX_SERVICE_ACCOUNT_KEY_BASE64` — a GCP service account key,
  base64-encoded onto one line. Create the service account (`gcloud iam
service-accounts create <name> --project=example-project-00000`), grant it
  `roles/aiplatform.user` scoped to that project (`gcloud projects
add-iam-policy-binding example-project-00000 --member=serviceAccount:<email>
--role=roles/aiplatform.user`), download a key (`gcloud iam
service-accounts keys create key.json --iam-account=<email>`), then
  `base64 -i key.json` and paste the single-line output as the secret value.
  Used only by `lib/ai/google-vertex-auth.ts` to sign a self-issued JWT and
  exchange it for a Vertex bearer token — see D-127 for why this exists
  instead of the simpler `X-Goog-Api-Key` the public Gemini API offers (that
  surface gates every call on a separate Prepay balance a linked Cloud
  Billing account doesn't satisfy; Vertex bills through ordinary postpaid
  Cloud Billing instead). `GEMINI_VERTEX_PROJECT_ID`/`GEMINI_VERTEX_LOCATION`
  are non-secret — they live in `config/env/*.runtime.env`, not here.

**PostHog:**

- `POSTHOG_PERSONAL_API_KEY` — click your account avatar (top right) →
  Personal API Keys → Create new (`phx_...`). Different from the project's
  public `POSTHOG_KEY`, which is git-committed in `fly.toml` now.

**Google Cloud Console** (APIs & Services → Credentials — **two separate
OAuth clients**, don't mix them up):

- `GOOGLE_OAUTH_CLIENT_SECRET` — the Calendar busy-import client. Redirect
  URI must be `${APP_URL}/api/calendar/google/callback`.
- `GOOGLE_CLIENT_SECRET` — the Sign-In client (paired with `GOOGLE_CLIENT_ID`,
  already in `fly.toml`). Redirect URI must be
  `${APP_URL}/api/auth/callback/google`.

**Azure Portal** → your Speech resource → Keys and Endpoint:

- `AZURE_SPEECH_KEY` — Key 1 or Key 2.

**LiveKit** (Cloud dashboard project → Settings → Keys, or your self-hosted
server's configured key pair):

- `LIVEKIT_API_SECRET` — paired with `LIVEKIT_API_KEY` (already in
  `fly.toml`'s commented block).

**Reclassified out of this list (2026-07-12), same secret-vs-not test as the
Supabase/Sentry/PostHog move above** — moved to `fly.toml`: `BETTER_AUTH_URL`,
`APP_URL`, `RESEND_FROM` (all just URLs/an email address, no credential
value), `STRIPE_PRICE_MONTHLY`/`ANNUAL`/`FOUNDING` (Stripe Price IDs — public
identifiers, not secrets), `WISE_API_BASE` (an API base URL),
`GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_CLIENT_ID` (OAuth client IDs are public by
design — only the paired `_SECRET` is sensitive), `LIVEKIT_URL` (already sent
to the client in the join grant, so it was never secret), `LIVEKIT_API_KEY`
(the identifier half of LiveKit's key/secret pair — `LIVEKIT_API_SECRET`,
which actually signs tokens, stays here), `AZURE_SPEECH_REGION` (a region
string). See `fly.toml`'s comments for each — some have real values already
transcribed, some are commented placeholders for not-yet-enabled features.

**`SUPERUSER_EMAILS` dropped entirely** — admin access is resolved via a DB
table instead, so this env var isn't needed at all.

`FIELD_ENCRYPTION_REQUIRED` also moved to `fly.toml` (it's a boolean flag,
not a credential) — but it's flagged there as a **DANGER** comment: it's a
hard cutover switch paired 1:1 with `FIELD_ENCRYPTION_KEY`
(`assertProductionCredentials()` hard-requires a valid key once this is set —
see `docs/security.md` §11.3), so setting it without the matching
key already live in Infisical hard-fails boot.

> **D-85 update — where the non-secret values live now.** Everything in the
> rest of this section that says a non-secret value "moved to `fly.toml`'s
> `[env]`" (or `[build.args]`) is still accurate about _what_ is non-secret and
> _why_ — but the **file** those values live in changed. They no longer sit in
> `fly.preview.toml` / `fly.production.toml` directly; they live in
> `config/env/<env>.runtime.env` (runtime) and `config/env/<env>.build.env`
> (`NEXT_PUBLIC_*` build-args). The Fly configs now carry only
> `NODE_ENV`/`PORT`/`APP_ENV`. This is what lets non-Fly environments (GitHub
> local dev) load the exact same config. The secret-vs-non-secret
> split this section documents is unchanged — read on for it — just mentally
> substitute `config/env/` for `fly.toml [env]/[build.args]`. See
> `config/env/README.md` and `docs/decisions/D-85.md`.

**`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SENTRY_DSN`, `POSTHOG_KEY`,
`POSTHOG_HOST` deliberately removed from this list — moved to `fly.toml`'s
`[env]` instead.** All five are non-secret by the underlying vendor's own
design (Supabase's anon key is RLS-protected and safe to expose; Sentry
DSNs and PostHog client keys are meant to ship in every site's client JS —
this is exactly why their `NEXT_PUBLIC_` twins already live in
`[build.args]`), and since this `fly.toml` is already scoped to one
environment (preview), committing them here carries none of the
cross-environment-drift risk that ruled out doing the same for the
`NEXT_PUBLIC_*` build-args. `SUPABASE_SERVICE_ROLE_KEY` and
`POSTHOG_PERSONAL_API_KEY` stay here — those are genuinely privileged (bypass
RLS / server-side flag evaluation), not the same class of value.
(`SUPABASE_JWT_SECRET` was here too, minting Realtime access tokens — retired
along with the two Realtime subscriptions it authed; see
`infra/database/neon/README.md`.)

`BETTER_AUTH_SECRET` and `ANTHROPIC_API_KEY` are included above because both
are real `env.ts` secrets read by `apps/web`.

> **Correction (2026-07-18).** An earlier revision of this section claimed a
> 2026-07-12 `fly secrets list` run showed `SUPABASE_URL`/`SUPABASE_ANON_KEY`/
> `SENTRY_DSN`/`POSTHOG_KEY`/`POSTHOG_HOST` and their `NEXT_PUBLIC_` twins set
> as Fly runtime secrets, and recommended a `fly secrets unset` cleanup. A live
> `fly secrets list --app agendaprofe-preview` (2026-07-18) shows **none** of
> those were ever imported — there is no such cleanup to do. (That same stale
> note also called Stripe and LiveKit "not set"; their secrets — `STRIPE_*`,
> `LIVEKIT_API_SECRET` — are in fact present.) The non-secret values now live
> in `config/env/` (D-85), never in `fly secrets`.
>
> ⚠️ **That correction checked the wrong app, and the conclusion does not
> hold for production (2026-09-05).** It ran against
> `agendaprofe-preview` and generalised "there is no such cleanup to do" to
> both. A live `fly secrets list --app agendaprofe` shows
> **`SUPABASE_PROD_DIRECT_URL` is set on production** — a direct Postgres
> connection string for a platform decommissioned by
> [D-89](../../docs/decisions/D-89.md), sitting on the live app for roughly
> seven weeks after the note that said there was nothing to clean up.
>
> Nothing reads it and nothing can start reading it:
> `apps/web/tests/config/decommissioned-platforms.test.ts` fails the build on
> any `process.env.SUPABASE_*` reference. It is not a live exposure so much as
> a credential nobody is tracking, which is the shape that survives rotations.
>
> Remove it with `--stage`, so it applies on the next deploy rather than
> restarting the single production machine now:
>
> ```sh
> flyctl secrets unset SUPABASE_PROD_DIRECT_URL --app agendaprofe --stage
> ```
>
> **The generalisable lesson is the one worth keeping**: preview and
> production are different apps and a `fly secrets list` against one says
> nothing about the other. Both correction notes above were written from a
> single-app read.

**Second pass, cross-checked against `grep -rhoE "process\.env\.[A-Z_]+"` over
`apps/web/src`, not just `env.ts`'s declared schema** (this catches anything
read directly off `process.env` that `env.ts` doesn't surface): added
`DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`, `AZURE_SPEECH_KEY`/
`AZURE_SPEECH_REGION` (live-captions/pronunciation-insights transcription
backends — real credentials, `env.ts` marks them optional and the features
degrade without them, same as Stripe/LiveKit above).

⚠️ **A retired push-delivery token was carried in `secrets.env.template` for
three weeks after it stopped being read**, and the table it delivered against
was dropped with it. It left the template on
2026-09-08, so a fresh vault is never populated with it again. **Revoking it at
the provider and deleting it from the vault is a separate job, tracked on the
board** — a template that no longer names a secret does not remove it from an
environment that already has it, and until then it is a live credential nothing
uses, which is the worst state for one to be in.

- **`DEEPGRAM_API_KEY` IS live on Fly** (confirmed 2026-07-17), so with
  `LIVE_CAPTIONS_ENABLED=1` (fly.toml `[env]`) and `ANTHROPIC_API_KEY`
  (already live), live captions are fully configured on preview. An earlier
  revision of this note said Deepgram was "in the code, not currently live on
  Fly" — that was stale; do not use it to conclude captions are dark for want
  of the key.
- `ASSEMBLYAI_API_KEY` and `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` back the
  separate transcription/pronunciation-insights features and their Fly status
  is not vouched for here — check `fly secrets list` before assuming either
  way.

**`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` deliberately dropped
from this list.** `lib/rate-limit.ts` uses them only as an optional
distributed-rate-limit backend — when unset it falls back to an in-memory
limiter (fine for single-region, alpha-volume traffic, which is what Fly
preview is). Not currently in the live `fly secrets list` output either.
Add it back if/when Fly preview actually needs cross-instance rate-limit
state; not needed today.

**Non-secret config/feature flags found in the same grep — deliberately
NOT routed through Infisical.** These aren't credentials, so hiding them in
a secrets manager is the wrong call; they're wired (commented out, since
their unset state is today's live behavior) into root `fly.toml`'s `[env]`
block instead — already used for `NODE_ENV`/`PORT` — which is plain,
version-controlled, and diff-reviewable: `CSP_ENFORCE`,
`LESSON_INSIGHTS_TRANSCRIPTION_ENABLED`,
`LESSON_INSIGHTS_PRONUNCIATION_ENABLED`, `LIVE_CAPTIONS_ENABLED`,
`STRIPE_TAX_ENABLED`, `ANTHROPIC_MODEL` and
`CAPTION_TRANSLATION_MODEL`. See `fly.toml`'s comments for each
var's current default and what enabling it actually does — uncommenting one
is a real behavior change on next deploy, review it like any other code
change. `NEXT_PUBLIC_SUPPORT_WHATSAPP` is the same kind of non-secret flag
but is also a `NEXT_PUBLIC_*` build-time var, so it can't go in `fly.toml`'s
`[env]` (runtime-only) — see the build-arg note below if it needs wiring.

This list should equal exactly what `fly secrets list --app agendaprofe`
shows (minus the R2 ones and the four inert `NEXT_PUBLIC_*` runtime copies
noted above), plus the credential-shaped vars above that are in the code
but not yet live on Fly. Don't pre-populate speculative future config that's
neither read by the code nor plausibly needed soon — but do add anything
`fly secrets list` shows that this list is missing.

**`NEXT_PUBLIC_*` build-time vars — now handled (D-85, was a gap).**
`NEXT_PUBLIC_*` vars are inlined into the client bundle at **Docker build
time**, not read from `fly secrets`/Infisical at runtime — see the comment
block in the root `Dockerfile`. They all live in `config/env/<env>.build.env`
now, and `scripts/env-build-args.mjs` feeds every one of them to the build as
`--build-arg` (via `.github/actions/fly-build-deploy` and
`scripts/fly-deploy.sh`) — so the earlier state where only three were wired,
and Sentry/PostHog weren't wired at all, is closed. The R2 public-bucket URLs
are still non-secret values manually sourced from the Cloudflare dashboard
(`infra/cloudflare-r2/README.md`'s "public URL is manual" note); they just live
in the build.env file like the rest now. None of this touches Infisical.

## Pushing to Fly

```
FLY_APP=agendaprofe INFISICAL_ENV=preview ./push-fly-secrets.sh
```

See `push-fly-secrets.sh`'s header comment for the caveats (unverified
`infisical export` format, restart-on-push behavior).

## Retiring `.env.fly.local`

Once `fly secrets list --app agendaprofe` shows everything above set (names
only — Fly never shows values back) and the app boots clean, delete
`.env.fly.local` from wherever it's been living locally. It was never
committed to git, so there's no history to scrub.
