# Security posture of this public repository

SpiralClass is a live system handling payments and personal data, published as
open source. This document answers two questions so a reader does not have to
reverse engineer them: **what does this repository deliberately expose, and why
is that safe?** It also states the application's security properties, including
the uncomfortable one.

To report a vulnerability, see [`SECURITY.md`](../SECURITY.md). For how a change
is reviewed before it reaches production, see
[`development/workflow.md`](development/workflow.md).

## The rule the configuration follows

Environment configuration is split on exactly one question — _is this a
credential?_ — into three tiers.

| Tier                 | Where it lives                                 | In this repository?          |
| -------------------- | ---------------------------------------------- | ---------------------------- |
| Non-secret           | `config/env/<env>.{build,runtime}.env`         | **Yes, deliberately**        |
| Secret               | Infisical, pushed to one Secret Manager secret | No                           |
| Infrastructure-owned | Read from OpenTofu state by that same push     | No — appears in no file here |

Committing the first tier is the unusual half, and it is on purpose: a
deployment's configuration becomes reviewable in a pull request instead of
living only in a vendor dashboard. **If a value in there ever needs to be
secret, that is the signal it belongs in Infisical, not that the file needs
gitignoring.** The infrastructure-owned tier is the R2 bucket credentials, which
`infra/gcp/push-cloudrun-env.sh` reads from `infra/cloudflare-r2`'s OpenTofu
state; because they appear in no file, their absence from `config/env/` is not
evidence that they are unset.

## What is committed, and what a value looks like

`config/env/` commits **every key, its position and its comment, and almost no
values.** A key whose value names an account this operator owns carries the
literal `__LOCAL__`, and the real value arrives at build or boot time from the
process environment or a gitignored overlay. [`config/env/README.md`](../config/env/README.md)
has the grammar and [`scripts/env-config.mjs`](../scripts/env-config.mjs) the
resolver, which throws if a `__LOCAL__` is still unresolved — it is a hard
failure, never a default.

Several of those values are public by construction — a Stripe publishable key
ships in every client bundle, a Sentry DSN accepts events and cannot read them.
They are held out anyway because the engineering signal in a configuration file
is carried by its keys, its structure and its comments, and no value carries
any; naming the accounts behind a live product buys the reader nothing
([D-158](decisions/D-158.md)).

- **Sentinel (`__LOCAL__`), real value held outside the repository:** the Stripe
  publishable keys, Price ids and Customer Portal configuration id; the Sentry
  DSN; the PostHog project key; the LiveKit API key (the identifier half —
  `LIVEKIT_API_SECRET` signs join tokens and is in Infisical); the Google OAuth
  client id; the Vertex AI project id; and both R2 public bucket URLs.
- **Deliberately empty:** `NEXT_PUBLIC_SUPPORT_WHATSAPP`. It once held a
  person's own number; empty rather than `__LOCAL__` means no environment
  variable can supply it again.
- **Real values, committed on purpose**, because each is a property of the
  product rather than of an account: `APP_URL`, `BETTER_AUTH_URL` and
  `LIVEKIT_URL`; the `RESEND_FROM` sender; `RTC_PROVIDER`; `CSP_ENFORCE`; the
  PostHog host; and every feature flag.
- **Local development credentials** (`postgres:postgres`,
  `SESSION_SECRET=local-development-session-secret-not-a-secret` in
  `config/env/local.runtime.env`) are the one set of real credentials here. They
  protect a database on your own machine that is identical for every developer,
  and nothing deployed loads them: `scripts/docker-entrypoint.sh` sources
  `config/env/$APP_ENV.runtime.env`, and a deployed `APP_ENV` is never `local`.

The self-hosted LiveKit machine's origin IP is **not** in this repository.
`livekit.spiralclass.com` is proxied by Cloudflare ([D-16](decisions/D-16.md)),
so hiding the origin is part of the protection; `scripts/local/synthetic.sh`
reads it from `LIVEKIT_ORIGIN_IP` and exits rather than guess.

## What is not here

- No Stripe secret or restricted key, in either mode.
- No webhook signing secret.
- No database connection string for any deployed environment.
- No private key material of any kind.
- No cloud provider access keys — AWS, Cloudflare, Oracle, Hetzner or otherwise.
- No `.env`, `.env.local`, `.env.production` or equivalent. Only `.example`
  templates and the deliberate non-secret tier above.
- No Terraform or OpenTofu state file, and no `tfvars` file — only
  `terraform.tfvars.example` templates.

**The secrets-rotation runbook is deliberately not published.** It holds no
values, but it enumerates every credential this project uses, where each one
lives and what each one reaches — a map of the estate, useful to a stranger
doing reconnaissance and to nobody reading this repository to learn how it is
built. The split it operates on is the one described above.

## The mechanism that keeps it that way

**Two scanners run in the fast tier of the gate on every push, and neither
subsumes the other.**

**gitleaks owns credentials**: curated provider rules plus entropy analysis,
maintained by people who watch credential formats change. It runs as the
`secret-scan` step, wrapped by
[`scripts/ci/secret-scan.mjs`](../scripts/ci/secret-scan.mjs) so it reports
only on files git would publish — gitleaks does not respect `.gitignore`, and a
gate that is red on every push over a developer's own `.env.local` gets skipped
within a week. Install it with `brew install gitleaks`, never the npm package of
that name.

**[`scripts/check-leaks.mjs`](../scripts/check-leaks.mjs) owns what a general
scanner has no concept of**, and runs inside the web unit suite
(`apps/web/tests/config/check-leaks.test.ts`). It treats four problems
differently, because they _are_ different:

- **Credentials — zero tolerance, no baseline.** A live key committed to git is
  compromised the moment it lands; the only remedy is rotation. Its patterns are
  tuned so a documented prefix in a comment, a short test fixture or a regex
  literal does _not_ match.
- **Account identifiers — zero tolerance, no baseline.** An OCID, a Stripe
  account id or a cloud project grants nothing alone, but in a public repository
  they aggregate into reconnaissance ([D-158](decisions/D-158.md)). The check
  holds patterns, never values.
- **People — zero tolerance, against a declared roster.** A name has no shape,
  so the gate does not try to recognise a real one. It finds **any** full name —
  a first name from [`scripts/given-names.json`](../scripts/given-names.json)
  followed by a capitalised word — and fails unless that exact name is declared
  in [`scripts/fixture-personas.json`](../scripts/fixture-personas.json), where
  every entry is invented and every not-a-name exception carries a reason.
  ⚠️ **It reads a reflowed copy of each file**, joining each line to the next,
  because the real names that survived earlier sweeps survived by having a line
  break between first name and surname. The dictionary is Spanish and English;
  a name outside it is a hole.
- **Personal data — ratcheted against a baseline.** Real addresses reach a
  repository through ordinary work, so existing occurrences are recorded in
  `scripts/check-leaks.baseline.json` and **new** ones fail. Every entry it
  still holds is synthetic: typo-correction and duplicate-detection fixtures
  that are deliberate misspellings of real free-mail domains
  (`mira@gmial.com`). Regenerating the baseline to turn a red check green is
  exactly the failure it exists to prevent.

Elsewhere, fixtures use `@example.com`, `@spiralclass.test`,
`@spiralclass-preview.invalid` and `@e2e.test`, and obvious placeholder phone
numbers such as the UK's reserved `+44 7700 900xxx` range.

## Personal data in this repository

**One real address is here on purpose:** the security contact in
[`SECURITY.md`](../SECURITY.md), a role address on this domain. Publishing it is
the point.

The seed reads the operator's and a tester's addresses from
`SEED_OPERATOR_EMAIL` and `SEED_PILOT_TEACHER_EMAIL`, and falls back to
`.invalid` addresses that RFC 2606 guarantees can never route mail — so an unset
variable cannot bootstrap an admin onto an address a stranger could register.
Screenshots of the live site and the pilot teacher's name were removed before
publication; a fictional persona replaces her everywhere.

**No production database record, export or dump has ever been in this
repository.** The seed builds fixtures programmatically and refuses to run
against a hostname listed in `PROD_DB_HOSTS`.

## A note on git history

Removing something from a working tree does not remove it from git, so **this
repository was published from a sanitised working-tree snapshot**: there is
nothing behind its first commit, and every change since has landed here as a
pull request. The development history behind that snapshot contained two real email
addresses in the commits that added them. Neither was a secret or a
vulnerability, but a permanent indexed copy of somebody else's inbox was not
the maintainer's to publish, and starting the public history at the sanitised
tree settled that outright.

## Application security properties worth knowing

- **Tenant isolation is application-level `teacherId` scoping. There is no
  row-level security.** A missing `where teacherId = ?` on an admin, webhook or
  service query is a vulnerability, not a style nit. It is checked twice
  ([D-175](decisions/D-175.md)): at the gate,
  `apps/web/scripts/tenancy-guard.mjs` parses every Prisma call and fails on a
  query against a tenant-owned model that does not constrain itself to a
  tenant, ratcheted against `apps/web/scripts/tenancy-guard.baseline.json`; at
  runtime, a Prisma extension (`apps/web/src/lib/tenancy/`) compares each
  query's tenant with the one the teacher auth gate recorded. Neither sees raw
  SQL, the parser cannot tell whether a scoped query was handed the _right_
  tenant, and the runtime half covers only the teacher gate and reports rather
  than blocks in production.
- **Authentication is passwordless** — a one-time code by email, or Google
  Sign-In — so there is no password database to breach. better-auth owns
  sessions and 2FA.
- **Admin access comes from the `AdminUser` table**, scoped by role and
  capability, and **every admin tier must present a fresh TOTP step-up** bound
  to the session (`apps/web/src/lib/admin.ts`). The `SUPERUSER_EMAILS`
  allowlist only bootstraps an empty table, and the built-in
  `BUILTIN_SUPERUSERS` constant in `apps/web/src/lib/env.ts` is empty so it
  cannot re-arm itself.
- **CSP carries a per-request nonce**, minted in the middleware
  (`apps/web/src/lib/auth/middleware.ts`, built by `apps/web/src/lib/csp.ts`),
  and is enforced rather than report-only where `CSP_ENFORCE=1`, as both
  deployed configurations set it.
- **Webhook signatures are verified** for Stripe — lesson payments and platform
  billing on separate endpoints with separate secrets, which must never be
  confused — and for Resend and LiveKit. With no secret configured, a Stripe
  endpoint refuses with `503` in production rather than skipping verification.
- **Field-level encryption** (AES-256-GCM, `apps/web/src/lib/crypto/field-encryption.ts`)
  protects per-teacher Wise API credentials and Google Calendar refresh tokens
  at rest. Without `FIELD_ENCRYPTION_KEY` it falls back to plaintext;
  `FIELD_ENCRYPTION_REQUIRED` turns that into a refusal to boot on production.
  The committed configuration does not set the flag.
- **The payee is a Wisetag, validated by pattern**, and there is deliberately
  no free-form payee field ([D-145](decisions/D-145.md)). That is the one place
  the transfer rail could lose real money with no way back.
- **Production credentials are asserted at boot** by
  `assertProductionCredentials()`, and only on production — every other
  environment degrades gracefully instead.
- **The `ap_vid` visitor identifier is HMAC-ed** before storage, and the
  acquisition ledger stores no IP address, user agent or referrer path — only
  the referrer's origin.

## If you find something

Do not open an issue or a pull request. See [`SECURITY.md`](../SECURITY.md).
