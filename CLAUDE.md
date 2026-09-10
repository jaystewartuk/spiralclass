# CLAUDE.md

**SpiralClass** — a pnpm monorepo for a scheduling, payments and video platform
used by independent teachers of any subject, anywhere in the world, and their
students. It is in production, on live payment rails.

This file is the **rule set for a session in this repository**: the invariants,
the commands, and the traps. It is deliberately small. Everything it does not
say is written down somewhere it points to, and _that_ document is the source of
truth — not a longer version of this one.

**Read this whole file. Then read the one document your task points at.**

---

## The four rules that override everything else

1. **A session opens a pull request. It does not merge, deploy or promote.**
   `pnpm pr` is the end of the road. Merging and `pnpm promote` are the
   operator's call, taken per change, on timing that is theirs. Every change —
   documentation included — lands through a PR; there is no direct-push
   exception.
2. **Never bypass the gate.** No `SKIP_GATE=1`, no `--no-verify`. A push that
   looks stuck is queuing on the machine lock and says so — wait for it.
3. **A change is not done until it ships with tests** covering the new
   behaviour and the regression it fixes.
4. **A claim nothing verifies is a claim that is eventually false.** Prefer an
   executable check to a sentence — in the code, and in the documents.

---

## Orientation

| Question                             | Read                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| How is it built?                     | [docs/architecture/overview.md](docs/architecture/overview.md)                             |
| What does feature X do?              | [docs/features/](docs/features/) — one file per feature, canonical                         |
| Why is it built this way?            | [docs/decisions/](docs/decisions/README.md) — current policy, not history                  |
| How does the database work?          | [docs/architecture/data-model.md](docs/architecture/data-model.md)                         |
| How do I test it?                    | [docs/development/testing.md](docs/development/testing.md)                                 |
| How does a change reach production?  | [docs/development/workflow.md](docs/development/workflow.md)                               |
| How is this repo worked with agents? | [docs/development/ai-assisted-engineering.md](docs/development/ai-assisted-engineering.md) |
| What does publishing this expose?    | [docs/security.md](docs/security.md)                                                       |

**`docs/features/` owns product behaviour.** Nothing else restates a business
rule; everything links to it. Hold what you write to the same rule.

**Decision records are current policy.** Before reversing anything a `D-NN`
constrains, read that record and say in your change what changed about its
premise. The `decision-scout` agent finds which records constrain a change
without loading them all into this context.

---

## Layout

```
apps/web/           Next.js 15, App Router. The only client and the only API tree
packages/shared/    Wire types, validators, money math, pricing/subscription
                    config, the i18n catalog — anything the handlers and the UI
                    must agree on. Look here before writing a helper in apps/web
packages/livekit-*  A captions worker (deployed onto the LiveKit box) and a CLI
docs/               See docs/README.md for the map
scripts/            The gate, the deploys, the local jobs
infra/              OpenTofu; each module documents itself
```

### Inside `apps/web`

- **`src/` is load-bearing.** `src/middleware.ts` is the only path Next.js
  loads middleware from; a copy at `apps/web/middleware.ts` compiles and is
  never invoked, silently disabling the CSP header, the session gate and
  `?ref=` attribution. Guarded by
  `apps/web/tests/config/middleware-placement.test.ts`. Never move it.
- **Route groups partition by audience, not by URL** — `(app)/` teacher,
  `(student)/` student portal, `(auth)/` magic-link sign-in, `b/[slug]/` the
  public booking funnel, `admin/` ops console, and `api/**` grouped the same
  way.
- **Pick the auth gate by caller.** A page route uses `@/lib/auth`'s
  `requireOnboardedTeacher`, which **redirects**. A handler taking a plain
  `Request` uses `@/lib/api/auth`'s `requireApiOnboardedTeacher`, which throws
  `ApiAuthError`, and wraps in `@/lib/api/route`'s `handle()` to turn that into
  a JSON body.
- **`src/lib/` is one folder per bounded concern** (`payments/`,
  `subscriptions/`, `booking/`, `auth/`, `inngest/`, …) plus flat utilities.
  Tests sit beside the module. Extend the existing folder rather than starting
  a flat file for a domain that already has one.
- **One entitlements resolver**: `entitlementsFor()` in
  `apps/web/src/lib/subscriptions/entitlements.ts`. Never branch on plan or
  tier anywhere else. Constants live in `config.ts` beside it.
- **Background work is Inngest** — `src/lib/inngest/` and `src/app/api/inngest/`.
- **`apps/web/src/lib/env.ts` is the runtime env contract.**
  `assertProductionCredentials` binds only on the production deploy; everything
  else is warn-only.

---

## Commands

Agents call `pnpm` directly. `just --list` is a human front door that delegates
to these and adds no logic of its own.

| Command                            | What it does                                                   |
| ---------------------------------- | -------------------------------------------------------------- |
| `pnpm gate --allow-dirty`          | **The fast tier, mid-work. Run it before you say you're done** |
| `pnpm dev`                         | Next.js dev server (port 3000)                                 |
| `pnpm typecheck` / `lint` / `test` | One check across every workspace (turbo-cached)                |
| `pnpm test:integration:local`      | Integration suite, booting the Postgres test container         |
| `pnpm gate:lock`                   | Who holds the machine, and who is queued                       |
| `pnpm pr`                          | Branch → push (runs the gate) → open the PR. Use `/pr`         |

Single file, single workspace — turbo tasks take no file arguments, so target a
workspace and forward after `--`:

```bash
pnpm --filter spiralclass-web test -- src/lib/money.test.ts
pnpm --filter @spiralclass/shared test -- src/money.test.ts
```

**Operator-only, never run from a session:** `pnpm promote`, `gh pr merge`,
`pnpm ship:preview`, `pnpm deploy:preview`, `scripts/fly-deploy.sh`,
`scripts/vercel-deploy.sh` and the bare `vercel` CLI, anything matching
`migrate:prod`, and `infisical`. These are denied in `.claude/settings.json` and
by a `PreToolUse` hook, so you will be stopped rather than trusted to remember.

---

## How a change is verified

**`scripts/ci/steps.mjs` is the single registry of what "green" means.**
`.githooks/pre-push` runs it on every push and posts the `local-gate` commit
status branch protection requires; `.github/workflows/gate.yml` runs the same
registry on every pull request. They cannot disagree about anything but timing.

⚠️ **Never add a check to a workflow.** Add it to the registry and the laptop
and the runner inherit it in the same commit. Guard tests in
`apps/web/tests/config/local-gate.test.ts` fail on a restated step.

- **fast** (`pnpm gate`) — prisma · format · doc counts · typecheck · lint ·
  web unit, coverage and diff-coverage · shared package tests · credential scan
  · dependency audit. The credential scan needs `brew install gitleaks`
  (⚠️ never the npm package of that name — an unrelated third party's).
- **heavy** (`pnpm gate:heavy`) — mutation spot-check, real-Postgres
  integration, E2E. Runs on a runner for every PR and every push to `main`, and
  needs Docker locally.
- **full** (`pnpm gate:full`) — both halves. What `pnpm promote` runs.

**One heavy job at a time.** Several sessions share one laptop through git
worktrees, so the gate and the heavy suites take a machine-wide lock and a
contended run **queues** rather than failing. Do not start a heavy suite to
"check something" while another session is working — `pnpm gate --allow-dirty`
is the cheap answer. `pnpm dev` holds port 3000, which the E2E suite needs, and
the lock does not know about it.

**Say which run you actually saw.** In a cloud session there is usually no
laptop and no `gh`: run `pnpm gate --allow-dirty` and let the pre-push hook run
the real one. Nothing posts a status from there — `gate.yml` does it on the PR —
so never imply you posted one you did not, and never report a check as green
that you did not watch finish.

**Prune the worktree when you are done with it.** Nothing caps how many exist,
and they are full checkouts: seven of them once held 18GB against 22GB free.

**Tier 2 — production-risk paths.** A change here needs explicit security
review, is worth a `GATE_TIER=full` push when you need the answer before the PR
is open, and is never merged during lesson hours:
`apps/web/src/lib/{payments,stripe,subscriptions,pricing,booking,cancellation,auth,webhooks,inngest}/**`,
`apps/web/src/lib/{auth,slots,csp}.ts`, `apps/web/src/middleware.ts`,
`apps/web/prisma/**`, `apps/web/src/app/api/{stripe,inngest}/**`.
When in doubt, it is Tier 2.

---

## Invariants

Each of these has cost real money or real correctness at least once. Breaking
one type-checks, lints and builds.

### Money

- **Integer minor units, never floats.** The major↔minor conversion is
  **currency-aware on both sides**: always pass the teacher's own currency —
  `currencyForTeacher(teacher)` on the server, the `PricingCurrencyProvider`
  context on the client. Omitting it multiplies a 0-decimal price (CLP, JPY,
  KRW, VND, PYG, UGX, XAF, XOF) by 100. A new curated currency needs its
  exponent added to `MINOR_UNIT_EXPONENTS` in the same change.
- **The teacher is the merchant of record and the platform never touches the
  money** (D-143). Connect **direct charges** on Accounts v2, created with the
  `Stripe-Account` header, settling in her country at her country's rates.
  **Never set `application_fee_amount`**, and never reintroduce a Transfer, a
  balance-transaction read-back or a reversal-on-refund path — there is nothing
  to reverse. A take-rate, if ever wanted, is a **billing** feature metered
  from the webhook; never a payments one.
- **Wise is the only manual payout rail** (D-145). `kind` stays an enum because
  it is what a second kind would return through. **Never add a free-form payee
  field** — every payee value a student pays against must be machine-checkable,
  because that is the one place this rail loses real money with no way back.
  `saveTeacherInstrument` is the only write path.
- **`pricing-fees.ts` is a deliberately generous estimate**, used only to size
  the Wise-rail discount suggestion. **Never present it as what Stripe
  charges** (D-152): teacher-facing copy names who charges the fee and links to
  Stripe's own page, and public marketing quotes no percentage at all. Guarded
  in `packages/shared/src/i18n/i18n.test.ts`.
- **"Bank transfer" is not a synonym for fee-free** — a transfer made _inside_
  Stripe checkout is a Stripe payment and carries Stripe's fee. Copy must name
  **Wise** as the rail that skips Stripe.
- Detail: [docs/features/payments.md](docs/features/payments.md).

### Subscriptions

- **The teacher's own v2 `Account` is the billing customer.** There is no
  platform `Customer` object and no mapping table; bill with `customer_account`.
  `teacher_subscriptions.stripe_customer_id` means "the thing we bill" and
  holds `acct_…` for everyone since D-143.
- **Subscription billing is a platform charge** — platform secret key, no
  `Stripe-Account` header, its own webhook endpoint and secret. Never confuse
  it with a lesson payment, which belongs entirely to the teacher.
- **Never paywall getting paid** — both payment rails stay free on every tier —
  and **never delete teacher data on downgrade**; over-cap data is grandfathered
  read-only. A teacher with no merchant account is still billable.
- Detail: [docs/features/subscriptions.md](docs/features/subscriptions.md).

### Data

- **There is no database-side RLS.** Application-level `where teacherId = ?` is
  the only tenant isolation, so every service-role, admin and webhook query
  needs an explicit scope filter.
- **An applied migration is never edited, not even a comment** — Prisma
  checksums each file and any drift breaks `migrate deploy` on the next
  environment. Correct a mistake with a new migration.
- **There are two migrations and the split is the point**: the regenerated
  Prisma baseline, and a hand-written invariants file holding what the schema
  language cannot say. ⚠️ **The drift check compares models**, so it cannot see
  a missing constraint.
- **Only one migration-bearing branch in flight at a time** — two collide on
  ordering and checksums.
- Detail: [docs/architecture/data-model.md](docs/architecture/data-model.md)
  and `apps/web/prisma/migrations/README.md`.

### Product framing

- **Not English-specific and not Mexico-specific.** A teacher's subject is a
  BCP-47 code in `teachers.target_language`, drawn from one registry
  (`packages/shared/src/languages.ts`). Public copy says **subject**; the
  schema is still narrower than the copy, and both halves are true at once —
  do not narrow the copy back to languages, and do not read it as a claim the
  column already takes arbitrary subjects. Guarded in
  `packages/shared/src/i18n/i18n.test.ts`.
- **Four language columns, all allowed to diverge**: `target_language` (what
  she teaches) · `teaching_language` (what she teaches in) · `locale` (what
  **she** reads) · `booking_page_locale` (what her **buyers** read). Conflating
  two of them has broken production twice; D-72, D-73 and D-133 are the record.
- **The public funnel (`/b/**`) renders in `booking_page_locale`**, resolved by
  `publicFunnelLocaleFor()`. The pages, the client layout and the social card
  all derive from that one value. **Never from the visitor's locale** — the
  social card is generated with no visitor, so a per-visitor rule reintroduces
  the split-language funnel this exists to prevent.
- **`DEFAULT_LOCALE` is `en`, and nothing falls back to Spanish.**
- **The MX-shaped constants are defaults and sentinels, not assumptions** —
  `DEFAULT_TEACHER_COUNTRY` marks "she has not picked yet";
  `DEFAULT_PRICING_CURRENCY` is a floor. Each is documented where it is
  declared. The unknown-timezone fallback is `FALLBACK_TIMEZONE` (UTC) and
  never a market's zone: a real zone renders a plausible wrong wall-clock,
  where UTC cannot be mistaken for a resolved answer.
- Detail: [docs/development/i18n.md](docs/development/i18n.md).

### Student acquisition

- **The planner is a pure function, not an AI call**
  (`packages/shared/src/marketing/planner.ts`). Claude writes the words; the
  planner decides the work and `insights.ts` decides what the numbers mean. A
  model must never be the thing that concludes "Facebook is working for you".
- **`promoPolicy` is the platform-safety gate.** A promotional content kind is
  never planned into a community whose policy is `prohibited` or `unknown`, and
  `unknown` is the default. Do not widen it, and never add a code path that
  posts, sends or scrapes anything on a teacher's behalf.
- **`acquisition_events` is written best-effort and never inside a payment
  transaction** — a failed statement poisons a Postgres transaction even when
  its JS error is caught.
- **A verified testimonial is written by the student, never by the teacher**
  (D-151). Teacher-side writes filter `source: "teacher_curated"`; the class
  count is derived at render time, never stored. **Never emit `Review` or
  `AggregateRating` JSON-LD** on the strength of one.
- Detail:
  [docs/features/student-acquisition.md](docs/features/student-acquisition.md).

### i18n mechanics

User-facing copy goes through the shared catalog via `getT()` (Server
Components) or `useT()` (Client Components). Two enforcement layers: the
`i18n/no-literal-string` ESLint rule on fully-migrated files, and the ratchet in
`apps/web/tests/i18n-guard.test.ts` elsewhere. If the guard flags a file you
touched, move the string into the catalog — never hand-edit the baseline upward
to dodge it. The help centre (`docs/help/`) is the deliberate carve-out: it is
authored per language, `<slug>.es-MX.md` beside `<slug>.md`.

---

## Never do

- **Reintroduce Supabase.** Decommissioned in D-89 Phase 5 — no dependency, no
  env var, no code path. **Vercel is different since D-175**: it is a deploy
  _target_ again — a second production target that holds no domain — while
  everything that coupled the app to it stays gone. No `VERCEL_ENV` branch
  (`APP_URL` decides prod-vs-preview), no `@vercel/*` dependency, and no root
  `vercel.json` (Vercel reads that one automatically, which is a deploy trigger
  nobody typed; the config lives in `config/vercel/`). Both halves guarded by
  `apps/web/tests/config/decommissioned-platforms.test.ts` and
  `apps/web/tests/config/vercel-deploy.test.ts`.
- **Reintroduce a mobile app or an `/api/mobile` tree.** The client and the 220
  routes named for it are both deleted. No React Native dependency, no
  Maestro flow, no CI step that builds one. Guarded in
  `apps/web/tests/config/local-gate.test.ts`.
  The lesson worth keeping: **when you retire a thing, retire its guard in the
  same change.** That route tree lived a month past its client because a guard
  whose premise had died went on making dead code look load-bearing.
- **Add a `run:` step to a workflow that performs a check** — see the gate,
  above.
- **Add a `TODO.md`, a backlog, a plans directory, or a dated audit whose last
  section is a findings list** (D-110). No queue lives in the tree — work owed
  is an issue on this repository ([D-172](docs/decisions/D-172.md)), where a
  pull request can close it.
- **Archive a superseded document** — delete it. Git history is the archive,
  and unlike a directory it cannot be mistaken for current policy.
- **State a number in the front-door documents without adding it to
  `scripts/readme-counts.mjs`.**

---

## Conventions

- **TypeScript throughout.** `pnpm typecheck` is the type safety net; `next
build` does not fail on type errors by itself.
- **Prettier formats the whole repo**, Tailwind class ordering included.
  ⚠️ If `pnpm format` rewrites files your branch never touched, a formatter or
  plugin version has changed what Prettier produces — land that reformat on its
  own rather than inside your branch, and do not hand-edit toward the other
  ordering.
- **Business rules the handlers and the UI must agree on live in
  `packages/shared`**, not duplicated at each call site.
- **Coverage** measures `src/lib/**`, `src/app/actions/**` and `src/app/api/**`
  only — views are E2E territory. The aggregate floor ratchets upward, never
  down.
- **Commit subjects and PR titles are a full sentence naming the problem the
  change fixed, in past tense, from the user's side** — not a category prefix.
  _"The class list said everything twice and could not say what was next"_, not
  _"fix: class list dedupe"_. The body says why; the diff says what.
- **A change that sets or reverses policy gets a decision record** — copy
  `docs/decisions/_template.md` to the next unused number and add a row to both
  tables in its README.

---

_This file is held to the tree by `apps/web/tests/config/claude-md.test.ts`:
every path and command it names must exist, the things it says are gone must
stay gone, and it must stay inside its context budget. If a claim here becomes
untrue, the gate fails._
