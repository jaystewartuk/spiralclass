# Security posture of this public repository

SpiralClass is a live system handling payments and personal data, published as
open source. This document exists so that a reader does not have to reverse
engineer the answer to two questions: **what does this repository deliberately
expose, and why is that safe?**

For reporting a vulnerability, see [`SECURITY.md`](../SECURITY.md) at the root.
For how a change is reviewed before it reaches production, see
[`docs/development/workflow.md`](development/workflow.md).

## The rule the configuration follows

Environment configuration is split on exactly one question — _is this a
credential?_ — into three tiers.

| Tier                 | Where it lives                         | In this repository?          |
| -------------------- | -------------------------------------- | ---------------------------- |
| Non-secret           | `config/env/<env>.{build,runtime}.env` | **Yes, deliberately**        |
| Secret               | Infisical, pushed to Fly secrets       | No                           |
| Infrastructure-owned | Written to Fly directly by OpenTofu    | No — appears in no file here |

Committing the first tier is the unusual half, and it is on purpose: a
deployment's configuration becomes reviewable in a pull request instead of
living only in a vendor dashboard, and a fresh checkout works without a
per-developer file that can drift or quietly hold a production URL. The rule
that keeps it honest is stated in the file headers — **if a value in there ever
needs to be secret, that is the signal it belongs in Infisical, not that the
file needs gitignoring.**

## What is committed, and what a value looks like

`config/env/` commits **every key, its position and its comment. It commits
almost no values.** A key whose value names an account this operator owns
carries the literal `__LOCAL__` instead, and the real value arrives at build or
boot time from the process environment or a gitignored overlay —
`config/env/README.md` has the grammar and `scripts/env-config.mjs` the
resolver. A `__LOCAL__` that reaches a build or a boot is a hard failure, not a
default.

That split is deliberate, and it is not a claim that any of these were
dangerous. Several are public by construction — a Stripe publishable key ships
in every client bundle, a Sentry DSN accepts events and cannot read them, a
PostHog project key is in every page that loads the client. What settles it is
that **the engineering signal in a configuration file is carried by its keys,
its structure and its comments, and no value carries any** — so a repository
that names the accounts, projects and tenants behind a live product buys the
reader nothing and adds a second, indexed, permanent copy.

**Sentinel values, real ones held outside this repository:** the Stripe
publishable keys, Price ids and Customer Portal configuration id; the Sentry
DSN; the PostHog project key; the LiveKit API key (the identifier half —
`LIVEKIT_API_SECRET` signs join tokens and is in Infisical); the Google OAuth
client id; the Google Cloud / Vertex AI project id; both R2 public bucket URLs;
and the support WhatsApp number.

**Real values, committed on purpose**, because each is a property of the
product rather than of an account: `APP_URL`, `BETTER_AUTH_URL` and
`LIVEKIT_URL`; the `RESEND_FROM` sender; `RTC_PROVIDER`; `CSP_ENFORCE`; the
PostHog region and host; and every feature flag.

- **Local development credentials** (`postgres:postgres`,
  `SESSION_SECRET=local-development-session-secret-not-a-secret`) are the one
  set of real credentials here — they protect a database on your own machine
  that is identical for every developer. Nothing loads
  `config/env/local.runtime.env` outside local tooling: `scripts/docker-entrypoint.sh`
  sources `config/env/$APP_ENV.runtime.env`, and `APP_ENV` is `preview` or
  `production`.

The self-hosted LiveKit box's origin IP is **not** in this repository. It used
to be, on the reasoning that it is already the published `A` record for
`livekit.spiralclass.com`; [D-134](decisions/D-134.md) removed it anyway,
because hiding the origin behind Cloudflare _is_ the protection and the `A`
record now points at the edge. `scripts/local/synthetic.sh` reads it from
`LIVEKIT_ORIGIN_IP` and exits rather than guess.

## What is not here, and never was

Verified across every file in the tree:

- No Stripe secret or restricted key, in either mode.
- No webhook signing secret.
- No database connection string for any deployed environment.
- No private key material of any kind.
- No cloud provider access keys — AWS, Cloudflare, Oracle, Hetzner or otherwise.
- No `.env`, `.env.local`, `.env.production` or equivalent has ever been
  committed. Only `.example` templates and the deliberate non-secret tier above.
- No Terraform or OpenTofu state file, and no `tfvars` containing a token. The
  two `tfvars` files that are committed carry topology — server size, region,
  repository names — with the secrets they pair with explicitly excluded and
  documented as such in the file.

**The secrets-rotation runbook is deliberately not published.** It contains no
values — it is a procedure — but it enumerates every credential this project
uses, where each one lives, and what each one reaches. That is a map of the
estate: reconnaissance for a stranger, and of no use to anyone reading this
repository to understand how it is built. It is kept privately. The split it
operates on is the one described above, and that split is fully documented here.

**There is no API key of any kind in the tree.** There was exactly one until
a workspace deletion took the file that held it, and the exception it needed in
`scripts/check-leaks.mjs` went with it.

## The mechanism that keeps it that way

**Two scanners run in the gate on every push, and neither subsumes the other.**

`gitleaks` owns credentials — ~170 curated provider rules plus entropy
analysis, maintained by people who watch credential formats change. That is the
half a hand-written regex list is worst at, and the half where "somebody looked
and saw nothing" is weakest evidence. It runs as the `secret-scan` step, scoped
by `scripts/ci/secret-scan.mjs` to the files git would actually publish: gitleaks
does not respect `.gitignore`, and run bare over this repo it reports fifteen
findings on a clean tree — every one a real credential in `.env.local` or
`config/env/*.local.env`, none of which can reach a commit. A gate that is red on
every push gets skipped within a week.

`scripts/check-leaks.mjs` owns what a general scanner has no concept of: this
operator's account identifiers, a person's name, and a real address in a
fixture. It treats its three problems differently, because they _are_
different.

**Credentials — zero tolerance, no baseline.** A live key committed to git is
compromised the moment it lands and stays compromised through every clone, fork
and CI log afterwards. There is no such thing as a grandfathered live key: the
only remedy is rotation. So that half fails on any match, and the patterns are
tuned so a documented prefix in a comment, a short test fixture, or a regex
literal does _not_ match — a check that produces noise is a check people learn
to skip.

**People — zero tolerance, against a declared roster.** This is the half that
had to be invented, because a name has no shape. `Renata Ocampo` and a real
student's name are the same nine-ish characters; no pattern can separate them,
and a sweep that says "I looked and saw nothing" is worth very little against
that. So the gate does not try to recognise a real name. It finds **any** full
name — a first name it knows, followed by a capitalised word — and fails unless
that exact name is declared in
[`scripts/fixture-personas.json`](../scripts/fixture-personas.json), where
every entry is invented on purpose and every not-a-name exception carries a
reason.

⚠️ **It reads a reflowed copy of each file**, joining every line to its
successor and dropping a comment marker on the continuation. That is not a
detail. Three separate sweeps of this repository reported the tree clean while
real names were still in it, and the ones that survived all survived the same
way: a line break had fallen between the first name and the surname, so no
`grep`, no reviewer scanning a diff and no earlier checker could see them.

The cost is honest: the gate only knows the first names in
[`scripts/given-names.json`](../scripts/given-names.json), which is Spanish and
English. A name outside that dictionary is a hole, which is why the roster is
kept short enough to read in full.

**Personal data — ratcheted against a baseline.** Real addresses reach a
repository through ordinary work: a seed fixture, a test built from a real
roster, a support thread pasted into a document. So existing occurrences are
recorded in
`scripts/check-leaks.baseline.json` and **new** ones fail — the same ratchet the
i18n guard uses, for the same reason: stop the bleeding without blocking on a
cleanup nobody scheduled.

Regenerating the baseline to turn a red check green is precisely the failure it
exists to prevent, and the script says so in its own header.

## Personal data that is in this repository, on purpose

Two real addresses used to be in the source, as the superadmin bootstrap and as
a seed fixture for a tester who needs an inbox that can actually receive a
sign-in code. **Both were removed before this repository went public.** The seed
reads them from `SEED_OPERATOR_EMAIL` and `SEED_PILOT_TEACHER_EMAIL`, set on
preview only, and falls back to `.invalid` addresses that RFC 2606 guarantees can
never route mail — so an unset variable cannot quietly bootstrap superadmin onto
an address a stranger could register.

Neither remains anywhere in this repository — see
[a note on git history](#a-note-on-git-history) below.

What is still here on purpose:

- **A security contact address in [`SECURITY.md`](../SECURITY.md)** — it is a
  role address on this domain, not a personal inbox. Publishing it is the point.

What was here and is now gone, deliberately:

- **Screenshots captured from the live site** were kept as before-and-after
  evidence for a design change, on the reasoning that they showed only content
  already served to anyone visiting the booking page, and that removing them was
  the teacher's call rather than a technical one. ⚡ **That call was made on
  2026-09-04: remove them.** They are gone from the tree, along with the pilot
  teacher's name, which is replaced everywhere by a fictional persona — and this
  repository's fresh history means there is no earlier copy of either.

  The reasoning that kept them was sound and the standard changed. The same
  pass that sanitises the operator's own financial and business information has
  no principled reason to make an exception for somebody else's. _Already
  public elsewhere_ is a weaker
  justification than it looks: a screenshot in a public git history is a second,
  permanent, indexed copy that its subject cannot revise or withdraw.

Everything the leak baseline still tracks is synthetic. The six remaining files
are typo-correction and duplicate-detection tests, whose fixtures are deliberate
misspellings at real free-mail domains (`mira@gmial.com`, `mira@hotmial.com`) —
they trip the detector precisely because the feature under test is about real
domains, and no person is behind any of them. Elsewhere the conventions are
`@example.com`, `@spiralclass.test`, `@spiralclass-preview.invalid`,
`@e2e.test`, and obvious placeholder phone numbers — `+52 55 1234 5678` and its
neighbours, plus the UK's reserved `+44 7700 900xxx` drama range.

## A note on git history

Removing something from a working tree does not remove it from git — which is
why **this repository was published from a working-tree snapshot and carries no
prior history.** There is nothing behind the first commit: no earlier revision
of any file here, and so no earlier revision to audit or to rewrite.

That is what settled the one thing the pre-publication audit could not
otherwise resolve. The development history contained two real email addresses —
one as the superadmin bootstrap, one as a seed fixture — in the commits that
added them. Neither is a rotatable secret
and neither is a vulnerability, but a second permanent indexed copy of somebody
else's inbox is not the maintainer's to publish, and rewriting thousands of
commits to remove it would have invalidated every existing clone and reference
for a benefit a determined reader could undo from the pull requests. Starting
the published repository at the sanitised tree costs the history and settles the
question outright.

**No production database record, export or dump has ever been in this
repository.** The seed script builds fixtures programmatically and refuses to
run against a hostname listed in `PROD_DB_HOSTS`.

## Application security properties worth knowing

Stated plainly, including the uncomfortable one.

- **Tenant isolation is application-level `teacherId` scoping. There is no
  row-level security.** A missing `where teacherId = ?` on an admin, webhook or
  service query is a vulnerability, not a style nit. This is the single largest
  security assumption in the system, and since [D-175](decisions/D-175.md) it is
  the one property here a machine checks rather than a reviewer:
  `apps/web/scripts/tenancy-guard.mjs` parses every Prisma call in the tree and
  fails the gate on a query against a tenant-owned model that does not constrain
  itself to a tenant. It parses rather than greps because five shapes contain
  the string `teacherId` and none of them filter — `teacherId: undefined` is a
  Prisma query with no `where` at all — and it ratchets against a baseline
  rather than claiming the tree is clean: **264 queries were unscoped the day it
  landed**, and that file is the list. What it cannot see is stated in the
  record: a `where` assembled at runtime, raw SQL, and whether the tenant id a
  scoped query was handed is the _right_ one.
- **Authentication is passwordless** — a one-time code by email, or Google
  Sign-In — so there is no password database to breach and no credential-stuffing
  surface. better-auth owns sessions and 2FA, and resolves one from a
  request's headers the same way whether the credential is a cookie or a bearer
  token.
- **Admin access is two independent mechanisms**: a capability-scoped
  `AdminUser` table and an env allowlist for superusers. The built-in allowlist
  constant is empty so it cannot re-arm itself if rows are added later.
- **CSP is enforced with a per-request nonce**, wired through the middleware in
  both deployed environments.
- **Webhook signatures are verified** for Stripe (two separate endpoints and
  secrets — Connect and Billing must never be confused), Resend and LiveKit.
- **Field-level encryption** exists for the most sensitive stored values —
  including per-teacher Wise API credentials — with a hard-cutover flag that
  refuses to boot without a valid key rather than silently falling back.
- **Payee details are checksum-validated** on every supported national scheme,
  and there is deliberately no free-form payee field. That is the one place the
  transfer rail could lose real money with no way back.
- **Production credentials are asserted at boot** by
  `assertProductionCredentials()`, and only on production — every other
  environment degrades gracefully instead.
- **The `ap_vid` visitor identifier is HMAC-ed** before storage, and the
  acquisition ledger stores no IP address, user agent or referrer path.

## If you find something

Do not open an issue or a pull request. See [`SECURITY.md`](../SECURITY.md).
Payment-path and auth-path reports are treated as drop-everything work.
