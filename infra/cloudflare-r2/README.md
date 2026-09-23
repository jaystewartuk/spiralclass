# R2 bucket + API token provisioning (OpenTofu, state in R2)

Codifies the R2 buckets and their per-bucket API tokens as IaC — see
[D-65](../../docs/decisions/D-65.md), which fixed the original module's
bucket list against the live account and split preview from production. The manual chore this replaces: every time a
feature needs a new bucket, someone creates it by hand in the Cloudflare
dashboard, creates a scoped R2 API token for it, and copies the resulting
Access Key ID / Secret into the host's secrets by hand. Adding a bucket here
becomes a one-line diff in `variables.tf`'s `buckets` list, and the production
push — `infra/gcp/push-cloudrun-env.sh` — reads the credentials straight out
of this module's state.

Provider: `cloudflare/cloudflare ~> 5`. Two resources per bucket:
**`cloudflare_r2_bucket`** and a bucket-scoped **`cloudflare_api_token`**
(one token per bucket, not one shared token — matches the current manual
setup, so a leak stays scoped to one bucket). State is stored in the same
**Cloudflare R2** bucket (`agendaprofe-tofu-state`) as the other infra/*
modules on the shared backend, under its own concern-keyed state path.

Works with **OpenTofu** or **Terraform** — the `.tf` files are identical;
only the CLI name differs (`tofu` ↔ `terraform`).

> **Status: APPLIED 2026-07-16.** All 12 `agendaprofe-{production,preview}-*`
> buckets + their scoped tokens are live and tracked in Tofu state (the last
> `apply` created the 8 that were missing). The sections below on importing /
> "before the first real apply" are kept as **history** — the live-API
> corrections in them (account-scoped token registry, Read+Write permission
> groups, the resources JSON key) are all confirmed and baked into `main.tf`.
>
> **Two things a future run must know:**
>
> 1. The **bare-named** buckets (`agendaprofe-teacher-photos`,
>    `-class-materials`, `-chat-audio`, `-recordings`) are the current **live
>    production storage** and are **deliberately NOT in state** — they were
>    `tofu state rm`'d on 2026-07-16 so Tofu forgets them (the real buckets
>    stay alive & unmanaged, like `agendaprofe-backups`). Do **not** re-import
>    them: adding them back to `variables.tf` or state makes the next plan
>    want to destroy live data. They get retired only after the post-launch
>    object migration + repoint (see the migration note above).
> 2. What remains is the **cutover** (still deferred, post-launch): `aws s3
sync` each bare bucket → its `agendaprofe-production-*` twin, then push
>    the new creds to production and flip its `*_R2_BUCKET` vars.
>
> ⚠️ **Both production pushes read this module's `production` credentials on
> every run**, so whether that cutover is still pending is not something this
> file can confirm. Check which `*_R2_BUCKET` values the running service
> actually has before acting on item 2.

## The bucket list (naming convention, updated for the Supabase→Neon migration)

Every managed bucket names its environment explicitly:
`agendaprofe-{production,preview}-<purpose>`. Seven purposes, each with its
own env-var family (irregular prefixes by history, not by design — see
`variables.tf`'s `env_prefix` field):

| Purpose             | `env_prefix`           | Consumed by                                                                       |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `class-materials`   | `CLASS_MATERIALS_R2`   | `apps/web/src/lib/storage/provider.ts`                                            |
| `teacher-photos`    | `TEACHER_PHOTOS_R2`    | `apps/web/src/lib/storage/provider.ts` (public)                                   |
| `teacher-videos`    | `TEACHER_VIDEOS_R2`    | `provider.ts`'s `R2_ENV_PREFIX` (intro video, public — D-73)                      |
| `student-photos`    | `STUDENT_PHOTOS_R2`    | `lib/storage/student-photo.ts` (student profile photo, **private** — signed URLs) |
| `chat-audio`        | `CHAT_AUDIO_R2`        | `provider.ts`'s `R2_ENV_PREFIX` (chat audio + video)                              |
| `material-podcasts` | `MATERIAL_PODCASTS_R2` | `provider.ts`'s `R2_ENV_PREFIX` (generated material podcasts)                     |
| `recordings`        | `LIVEKIT_EGRESS_S3`    | `provider.ts`'s `R2_ENV_PREFIX` (lesson audio + recordings)                       |

`student-photos` was dropped by D-65 as "speculative" but is in fact a live,
fully-wired feature (student account → upload profile photo, via a server
action). It went unprovisioned, so uploads silently no-op'd until it
was added here (2026-07-16). Unlike teacher-photos it's **private** (no public
domain / `NEXT_PUBLIC_*` URL — reads go through short-lived signed URLs).

So the `buckets` list is 14 entries: an `agendaprofe-production-<purpose>`
and an `agendaprofe-preview-<purpose>` per row above — a separate bucket and a
separate token each, not a shared bucket split by env-var target. Production's
credentials reach Cloud Run through `infra/gcp/push-cloudrun-env.sh`; preview
has no host today, so nothing pushes its credentials.

> **Migration note (Supabase→Neon, D-70).** The original **bare-named**
> buckets (`agendaprofe-teacher-photos`, `agendaprofe-class-materials`,
> `agendaprofe-chat-audio`, `agendaprofe-recordings`, and the manually-made
> `agendaprofe-teacher-videos`) are the **current live production storage**
> — `getStorageProvider()` returns R2 unconditionally
> (`provider.ts:304`). They are deliberately **NOT** in this module's
> `buckets` list, so Tofu never touches them. The fresh
> `agendaprofe-production-*` buckets this module creates start **empty** and
> serve nothing until a **post-launch cutover**: copy each old bucket's
> objects into its new twin (`rclone`/`aws s3 sync`), then push the new
> production creds (`infra/gcp/push-cloudrun-env.sh`, then a deploy) to
> repoint production's `*_R2_BUCKET` env vars. Creating the empty buckets now
> is risk-free; the repoint is the only user-visible step, and it is
> intentionally deferred. Full runbook in "Post-launch production cutover"
> below.
>
> `agendaprofe-backups` (DB backups, separate credentials — D-65) also stays
> outside this module.

`student-photos` (from the original scaffold) is **not** in this list
— it was speculative, never had a real bucket or a real env var wired to
it (`STUDENT_PHOTOS_R2_*` was never set anywhere), so D-65 dropped it
rather than provisioning a bucket nothing reads. The app-code reference
(`student-photo.ts`) is unaffected and untouched — it just stays
unconfigured, same as before.

### `teacher-photos`' public URL is manual, not a Tofu output (D-66)

`teacher-photos` is the one `public = true` bucket, but per `variables.tf`'s
comment, **`public` is metadata only — this module does not provision the
actual public domain** (Cloudflare r2.dev subdomain or a custom domain).
`apps/web/src/lib/storage/r2-public-url.ts` reads that domain from
`NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL`, set by hand from whatever's
configured in the Cloudflare dashboard (R2 bucket → Settings → Public
access) — same manual-copy chore this module exists to replace for the
other bucket fields, just not yet extended to this one. It's non-secret
(a public URL) and, being `NEXT_PUBLIC_*`, is inlined into the client
bundle at **Docker build time** — it can't flow through a runtime secret push
at all. It's a `__LOCAL__` key in `config/env/<env>.build.env`, resolved at
build time and passed as a build-arg to the root `Dockerfile` (see
`config/env/README.md`).

If this value ever needs to change (bucket recreated, custom domain
swapped), update it in two places by hand: the Cloudflare dashboard's public
access setting, and wherever that `__LOCAL__` key resolves from for the
build. A real
fix would make this module provision/output the domain like it does the
other bucket fields — deliberately not done here (bigger change than a
doc note), flagged for a future pass if this manual step becomes a
recurring pain.

## Before the first real apply

Live import against the real account on 2026-07-12 confirmed and fixed two
things the module's original guess got wrong (see `main.tf`'s "CORRECTED LIVE"
comments and D-65): the per-bucket tokens live in Cloudflare's
**account-scoped** token registry (`cloudflare_account_token`), not the
user-scoped `cloudflare_api_token` the first pass guessed — importing a real token id
against the wrong resource type 404s ("token not found") even with a
correct id — and the matching permission-group lookup
(`cloudflare_account_api_token_permission_groups_list`) is account-scoped
too, so `CLOUDFLARE_API_TOKEN` needs no separate "User API Tokens"
permission. The permission-group name itself
(`"Workers R2 Storage Bucket Item Write"`) is also now **confirmed
correct** — it resolved successfully once account-scoped.

The **R2 resource-scoping JSON key**
(`com.cloudflare.edge.r2.bucket.<account_id>_default_<bucket_name>`) is
also now **confirmed correct**, and so is the Read+Write permission-group
fix above: `tofu plan` on the fully-imported `agendaprofe-teacher-photos`
bucket + `agendaprofe-teacher-photos-r2` token reported **"No changes"**
end to end (0 to change) — every field lines up with the live resources.
The same pattern (import each remaining production bucket, confirm "No
changes") should hold for the other 3.

**The S3 access-key derivation is now VERIFIED (2026-07-16) — and the first
guess was wrong.** Cloudflare's documented mechanism
(https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token)
is: **Access Key ID = the token's `id` verbatim**, **Secret Access Key =
SHA-256 hex of the token's `value`**. The original module used
`access_key_id = md5(token.id)`, which produced a **401 Unauthorized** — now
fixed in `main.tf` to `token.id`. Confirmed live: a Tofu-created token's
`id` + `sha256(value)` authenticated against the R2 S3 endpoint (rclone
`ListObjectsV2` → 200) during the 2026-07-16 object migration. Two notes:
`secret_access_key` stays wrapped in `try(..., null)` because `token.value`
is `null` for an **imported** token (Cloudflare never returns it again), so
only Tofu-created tokens get a real derived secret; and a freshly-created
token takes up to ~1 min to propagate to the S3 endpoint before it
authenticates (a transient 401 right after `apply` is expected, not a cred
error).

Still unverified: `import.sh`'s `cloudflare_account_token` import ID format
(`<account_id>/<token_id>`, guessed by analogy with the bucket resource's
own `<account_id>/<bucket_name>/<jurisdiction>` shape) — if the token
import errors on ID shape rather than 404s, that's the next thing to fix.

None of these are guessable from a training cutoff with confidence — they
are exactly the kind of Cloudflare-internal wiring detail that only the
live API can confirm. `tofu plan`'s "No changes" after import is the real
verification; do not skip straight to `apply`.

## Prerequisites

1. **The R2 state bucket.** ✅ Already created — `agendaprofe-tofu-state`
   (shared with every other infra/* module on the shared backend). See
   `../README.md` for how to recreate it if needed.
2. **An R2 S3 API token for the _state_ bucket** (R2 → Manage R2 API
   Tokens → Object Read & Write, scoped to `agendaprofe-tofu-state`). This
   can be the **same** token already exported for the other modules on the
   shared backend — no new credential surface for the backend itself.
3. **A Cloudflare API token for the provider** — needs, at account scope:
   **Account API Tokens: Edit** (to create/import the per-bucket tokens
   this module manages) and **Workers R2 Storage: Edit** (to
   create/import buckets). Passed via `CLOUDFLARE_API_TOKEN`, never
   committed. Both are account-scoped (not "User") — the per-bucket tokens
   this module manages, and the permission-group lookup it does to build
   them, both live in the account-scoped `cloudflare_account_token` /
   `cloudflare_account_api_token_permission_groups_list` registry
   (confirmed live 2026-07-12), not the user-scoped `cloudflare_api_token`
   one the first pass guessed. No `User API Tokens` permission is
   needed at all with the account-scoped versions.

## Configure

```sh
cd infra/cloudflare-r2

cp ../backend.hcl.example      ../backend.hcl       # account id, once per checkout
cp terraform.tfvars.example   terraform.tfvars     # account_id — only for plan/apply

../infisical/run.sh infra tofu init -backend-config=../backend.hcl
```

Both files are **gitignored**, and both hold the Cloudflare account id — the
hex string in any R2 endpoint URL. They were committed until 2026-09-04 and
templated ahead of the repository going public, so every checkout (and every
worktree) fills them in once. `../backend.hcl` is still the one shared
partial-backend config every R2-state module points at; see `infra/README.md`.
Reading state — `tofu output`, which `infra/gcp/push-cloudrun-env.sh` does —
needs only the backend file, not
`terraform.tfvars`.

### Credentials come from Infisical's `infra` environment (D-66)

The three secrets this module needs to _run_ are pulled from Infisical's
dedicated **`infra`** environment (the repurposed free `development` slot —
NOT `preview`/`production`, which are pushed wholesale to the deploy targets), so you never
re-export them by hand. Prefix every `tofu` invocation with
`../infisical/run.sh infra` (see "Configure" above). It resolves the project
wherever its link lives — `infra/infisical/.infisical.json` or
`~/.infisical.json` — and checks it against `infra/infisical/project.sha256`
before injecting them for that command only, off argv and out of shell
history. The bare `infisical run --project-config-dir=../infisical` this used
to name finds only the first of those, and checks neither. The three keys, stored under these **exact** names:

| Infisical key           | Read by                   | What it is                                |
| ----------------------- | ------------------------- | ----------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | the `cloudflare` provider | account-scoped provider token (see above) |
| `AWS_ACCESS_KEY_ID`     | the `s3` state backend    | state-bucket R2 access key id             |
| `AWS_SECRET_ACCESS_KEY` | the `s3` state backend    | state-bucket R2 secret access key         |

**Why `AWS_*` for a Cloudflare bucket:** the state backend is OpenTofu's
`backend "s3"` (`main.tf`), which reaches R2 over the **S3 API** and reads
credentials via the AWS SDK's credential chain — that chain looks for exactly
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. The name is the S3
protocol/SDK, not the vendor; R2 just speaks S3. Renaming them breaks
`tofu init` (backend finds no credentials). This is also why `infra/aws-ses`
uses a named AWS profile instead of the bare env vars — to avoid colliding
with these. These creds are shared across the infra modules —
`CLOUDFLARE_API_TOKEN` also by `infra/cloudflare` — so `--env=infra` serves
every module.

## Import any already-created buckets before the first apply

Every `agendaprofe-production-*` bucket is **fresh** — none has ever
existed. On the current scheme there is **nothing to adopt on the production
side**: `apply` creates all six `agendaprofe-production-*` buckets and tokens
from scratch (the old bare-named live buckets are out of scope — see the
migration note up top). Two preview buckets are also brand-new:
`agendaprofe-preview-teacher-videos` (D-73) and
`agendaprofe-preview-material-podcasts`.

The **only** import risk is the four **older** `agendaprofe-preview-*`
buckets that already exist (chat-audio, class-materials, recordings,
teacher-photos). If their Tofu state persisted from the apply that created
them, `tofu plan` shows them as no-ops and you can skip straight to apply.
If state was lost,
`plan` will try to **create** them — which would fail on the unique-name
collision (safe) but silently mint orphan tokens (not dangerous, but defeats
the module). Confirm with `tofu plan` first; if it wants to create an
already-existing preview bucket, import it before applying:

```sh
TOKEN_ID=<existing token's id — see import.sh header> ../infisical/run.sh infra ./import.sh agendaprofe-preview-chat-audio
TOKEN_ID=<existing token's id>                        ../infisical/run.sh infra ./import.sh agendaprofe-preview-class-materials
TOKEN_ID=<existing token's id>                        ../infisical/run.sh infra ./import.sh agendaprofe-preview-recordings
TOKEN_ID=<existing token's id>                        ../infisical/run.sh infra ./import.sh agendaprofe-preview-teacher-photos
```

If an import shows a diff on a bucket/token, see "Before the first real
apply" above — fix `main.tf` to match the live resource, never apply to
force a match.

## Creating the buckets

Once `tofu plan` is clean (no unexpected changes to existing preview
buckets):

```sh
../infisical/run.sh infra tofu plan   # EXPECT: 8 to add — 6 agendaprofe-production-* + agendaprofe-preview-{teacher-videos,material-podcasts} (each a bucket + a token) — 0 to change/destroy
../infisical/run.sh infra tofu apply
```

This creates the eight new **empty** buckets. Nothing in production is
repointed by this step — the live bare-named buckets keep serving until the
post-launch cutover (migration note up top). Preview has no host today, so
there is nowhere to push the **preview** credentials until it has one again.

Do **not** run a production push as part of this step — it would carry the
new `production` credentials to the live service, which is the deferred
cutover below.

## Post-launch production cutover (deferred)

When you're ready to move production off the bare-named buckets:

1. **Copy the objects** — for each bare bucket, sync it into its
   `agendaprofe-production-*` twin over the S3 API (needs an R2 token with
   read on the source + write on the destination):
   ```sh
   for p in class-materials teacher-photos teacher-videos chat-audio material-podcasts recordings; do
     : # map bare→prod name (teacher-videos/material-podcasts have no bare twin yet — skip those)
   done
   # e.g. with rclone remotes 'r2src'/'r2dst' pointed at the R2 S3 endpoint:
   rclone sync r2src:agendaprofe-teacher-photos r2dst:agendaprofe-production-teacher-photos
   # …repeat for class-materials, chat-audio, recordings.
   ```
   (`teacher-videos` and `material-podcasts` have no bare-named predecessor —
   nothing to copy; they start empty.)
2. **Repoint production** — run `infra/gcp/push-cloudrun-env.sh` (operator),
   which writes the production creds into Cloud Run's runtime secret, and
   deploy so a new revision mounts it.
3. **Re-enable public access** by hand for the two `public = true` buckets
   (`agendaprofe-production-teacher-photos`, `-teacher-videos`) and update the
   `NEXT_PUBLIC_*_R2_PUBLIC_URL` build-args (Dockerfile) — the module doesn't
   provision public domains.
4. Once verified, the bare-named buckets can be deleted from Cloudflare by
   hand (they're unmanaged by Tofu on purpose).

## Adding a new bucket

1. Add a production entry (and, if it needs a preview counterpart, a
   matching `environment = "preview"` entry) to `buckets` in
   `terraform.tfvars` (or override the `variables.tf` default).
2. `tofu plan` — should show exactly one new `cloudflare_r2_bucket` and one
   new `cloudflare_api_token` per entry added, nothing else.
3. `tofu apply`.
4. Add the bucket's `env_prefix` to
   `apps/web/src/lib/storage/provider.ts`'s `R2_ENV_PREFIX` map (still a
   manual one-line code change — this module doesn't touch application
   code), then re-run `infra/gcp/push-cloudrun-env.sh` so production carries
   the 5 env vars, and deploy.

## Notes

- **`location`/`storage_class`/`jurisdiction`** are deliberately left unset
  in `main.tf` (optional+computed) so importing a bucket never produces a
  diff regardless of what the dashboard-created bucket already has.
- **Public bucket access** (custom domain / `r2.dev` URL) is metadata-only
  here (`buckets[].public`) — this module does not provision it. Setting
  up a bucket's public URL and the app's
  `NEXT_PUBLIC_<PREFIX>_PUBLIC_URL` var stays a manual step, same as
  today (only the teacher-photos buckets have one currently).
- **State bucket reuse**: this module points at the same
  `agendaprofe-tofu-state` bucket as the other infra/* modules via the
  shared `infra/backend.hcl`, just a different `key` per module
  (concern-keyed per D-49) — no new R2 bucket for state.
- **Why per-bucket `env_prefix` instead of deriving it from `name`**: the
  four production env-var families predate this module and don't follow
  one consistent rule (`LIVEKIT_EGRESS_S3` doesn't even share the bucket's
  own name) — see D-65. A future cleanup could rename the underlying env
  vars to a uniform scheme, but that's an app-code change with its own
  deploy risk, out of scope here.
