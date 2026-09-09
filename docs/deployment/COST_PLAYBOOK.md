# Cost Playbook

> **Audience:** whoever pays this project's infrastructure bill — and anyone
> running a project in the same shape (Next.js / Neon Postgres / Stripe-ish).
> **Goal:** run as close to $0/month as possible at this scale, with a clear,
> ordered list of what to pay for first when usage actually demands it.
>
> **Scale assumption:** one teacher + their students. Tens of MAU, not
> thousands. If a project crosses into hundreds of MAU, re-read the
> "When to actually start paying" section.

## TL;DR

| Component           | Provider                       | Plan          | Monthly        |
| ------------------- | ------------------------------ | ------------- | -------------- |
| Hosting             | Fly.io                         | pay-as-you-go | ~$5.70 (D-150) |
| Database            | Neon                           | Free          | $0 (verify)    |
| Auth                | better-auth (in-app)           | n/a           | $0             |
| Storage             | Cloudflare R2                  | Free          | $0             |
| Error tracking      | Sentry                         | Developer     | $0             |
| Transactional email | Resend                         | Free          | $0             |
| Uptime monitor      | UptimeRobot **or** BetterStack | Free          | $0             |
| LLM (if used)       | Anthropic API                  | Pay-as-you-go | ~$0–5          |
| Domain              | Registrar of choice            | n/a           | ~$1 (≈ $12/yr) |
| **Total**           |                                |               | **~$7/mo**     |

Hosting and the domain are the only unavoidable costs. Everything else is
$0 until usage forces an upgrade — and [D-150](../decisions/D-150.md) is
the decision to take hosting to $0 as well, by moving the web app onto the
Oracle Always Free box. Until that is executed, the total above is what
this actually costs.

---

## Stack by component

### Hosting — Fly.io

> [!IMPORTANT]
> **"$0 (verify)" in the table above was wrong, and it has now been verified.**
> **Fly has no free tier.** Production is one always-on `shared-cpu-1x`
> machine with 1024 MB in `ord`, which is roughly **5.70 dollars a month** —
> essentially the whole SpiralClass line, since neither app has a volume or a
> dedicated IPv4. Fly's actual floor is `min_machines_running = 0` (what
> preview already runs), which costs pennies of rootfs storage and buys an
> eight-to-ten second cold start.
>
> **[D-150](../decisions/D-150.md) (2026-09-03) decided the web app moves to
> the Oracle Always Free box** for that reason, keeping Fly configured as a
> first-class target to return to. Read it before re-deriving any of this: it
> carries the measured latency cost of the move (58 ms to Neon from Querétaro
> against 12 ms from `ord`, an estimated 1.3 seconds on database-heavy pages),
> and the reason Postgres must **not** follow the app onto the box. Nothing has
> moved yet.

- **Cost shape:** pay-as-you-go on machine + volume usage; a single
  small always-on machine for a low-traffic app is cents-to-low-dollars
  per month (verify against the current Fly pricing / your usage). No
  "hobby vs pro" commercial restriction — commercial use is fine on any
  plan.
- **Why it fits:** a single classroom's traffic keeps machines idle
  most of the time; auto-stop/auto-start machines mean you're not paying
  for a box that's doing nothing.
- **Alternative if it gets expensive:** Cloudflare Pages/Workers (more
  generous free tier) or Railway/Render, though the app is currently
  containerized for Fly.

### Database — Neon Free

- **Free quota:** generous free tier (storage + compute-hours; verify
  the current limits), branching, one project.
- **Why keep it:** serverless Postgres that scales to zero — you pay
  ~nothing while idle, and it's a plain Postgres wire-protocol DB with
  no vendor lock-in on the data layer.
- **Multi-project tip:** one project per side-project keeps quotas and
  branches isolated.
- **Risk — auto-suspend:** free-tier compute suspends after a period of
  inactivity and cold-starts on the next connection (verify the current
  window). During the school year a teacher + students keep it warm;
  summer break and holidays are the danger window. Cold-start is a
  sub-second-to-few-seconds resume — acceptable for an alpha.

### Auth — better-auth (in-app)

- **Cost:** $0. Auth runs inside the web app (`better-auth`) against the
  Neon Postgres DB — there's no separate auth vendor or per-MAU billing.
- **Why it fits:** no external auth service to pay for or rate-limit;
  the only email involved (magic-link / OTP) goes through Resend (below).

### Storage — Cloudflare R2

- **Free quota:** 10 GB storage, **zero egress fees** (verify the
  current free allowances). R2 is meaningfully cheaper than S3 at scale
  precisely because of the egress pricing.
- **Why it fits:** user uploads and call/lesson-audio artifacts live in
  R2; at a single classroom's volume this stays well inside free.

### Error tracking — Sentry Developer

- **Free quota:** 5k errors/mo, 10k tracing spans/mo, 1 user, multiple
  projects sharing the cap.
- **Skip Sentry Uptime.** Uptime is Team-plan only ($26/mo). Use a
  free uptime monitor instead.

### Transactional email — Resend

- **Free quota:** 3,000 emails/month, 100/day, one verified domain
  per account.
- **Why Resend:** better-auth has no built-in mail sender and Neon isn't
  an email service, so transactional email needs a dedicated provider.
  Resend's 100/day free tier is a drop-in for magic-link, OTP, and
  notification email.
- **Multi-project tip:** one Resend account covers multiple verified
  domains; the 3k/mo cap is shared.

### Uptime monitor — UptimeRobot or BetterStack

- **UptimeRobot free:** 50 monitors, 5-minute interval.
- **BetterStack free:** 10 monitors, 3-minute interval, prettier
  dashboard.
- **Setup:** point at `/api/health` (already exists — returns 200 on
  success, 503 on DB unreachable). Alert after 2 consecutive
  failures so a single transient blip doesn't page you.

### CI/CD — GitHub Actions

> **As of [D-129](../decisions/D-129.md) (2026-08-25) this line item is £0 and
> there is nothing left to tune.** Every workflow and composite action in this
> repo is deleted — the deploy, the dispatch-only gate fallbacks, and all three
> crons. Everything runs on the operator's machine, by hand
> ([`LOCAL_AUTOMATION.md`](./LOCAL_AUTOMATION.md)). The rest of this section is
> kept as the reasoning trail, because the levers it describes are the ones that
> would matter again if Actions ever came back — and because the "stay private"
> argument below is unchanged and still binding.
>
> **What tipped it was not the arithmetic.** D-120 had already measured the
> month down to ~780 billable minutes, comfortably inside the allowance. What
> the arithmetic did not prevent was the allowance emptying anyway: every
> private repo's workflows started failing at once, and production's Postgres
> went **eleven days with no backup** while the public repos stayed green. A
> backup whose availability depends on how many minutes the month's merges
> consumed is not a backup you can reason about, at any price.

- **Free tier:** 2,000 Linux minutes/month on a **private** repo. Stay private.
- **Do NOT go public to save minutes.** Public repos do get unlimited free
  Actions, but SpiralClass is a **commercial product with potential resale
  value**, so this is the wrong trade: a public repo exposes the _implementation_
  (data model, payout/fee logic, auth + security flows — the real moat; the
  product idea is already visible to anyone who signs up), hands attackers a map
  of a money-handling app, and muddies the IP/due-diligence story in any future
  sale. Keep it private.
- **Largest structural cut to date — D-119 (2026-08-12): the test tiers moved
  onto the dev machine.** The per-PR fan-out (`main-checks.yml` → five parallel
  `checks.yml` jobs, each with its own `pnpm install`, on every push to every
  PR) and the promote fan-out (integration + E2E + the browser suites)
  now run locally via `pnpm gate` / `pnpm gate:full`, at zero Actions minutes.
  What still bills: the web deploy (`fly-deploy.yml` — Fly is amd64-only and
  this laptop is arm64), three crons, and any dispatched fallback run. Combined
  with taking mobile builds and OTA publishes out of CI, the two biggest recurring line items
  are gone; the trims below are now the second-order levers, not the first.
- **Second structural cut — D-120 (2026-08-17): the web deploy followed**, into
  `pnpm promote` itself (~744 billable min/month, the largest single line).
- **Final cut — D-129 (2026-08-25): everything else, deleted.** The three crons
  became `pnpm local synthetic | sweep`, run by hand with a staleness
  nag in the gate; the dispatch-only fallbacks went with them, which saves no
  minutes and removes the only path that worked without this machine. That cost
  is stated in D-129 rather than discovered later.
- **Biggest minute sinks while Actions was still in use, in order:** the deploy
  workflow (image build dominates); the nightly sweep (slimmed at D-119 to the
  unit suites + audit — the only checks a clock can break — via
  `time_dependent_only`); a dispatched fallback gate; chatty Dependabot (each PR
  re-ran the full matrix). Dependabot itself stays: it is not Actions and spends
  no minutes, though its `github-actions` ecosystem was removed with the
  workflows it had nothing left to pin.
- **Levers applied here (see `../development/workflow.md`):**
  path-filter heavy suites so docs and copy PRs skip them; gate a not-yet-live
  suite behind a repo variable so it costs 0 (E2E behind `E2E_ENABLED`); cut
  cron frequency where an external monitor already covers liveness (synthetic →
  6h, UptimeRobot is primary); batch Dependabot monthly. Use `cancel-in-progress`
  concurrency so a rapid second push doesn't double-bill. **Turborepo remote
  cache (Vercel), free tier:** the gate's `typecheck`/`lint` steps
  (`turbo run typecheck` / `turbo run lint`) read/write Vercel's remote cache
  when `TURBO_TOKEN`/`TURBO_TEAM` are set, so a push that doesn't touch a
  workspace's inputs gets a cache hit instead of re-running it — cuts wall-clock
  on every run, self-hosted or not, and costs nothing (Vercel Remote Cache has
  no separate paid tier). One-time setup: create a Vercel **Account Settings →
  Tokens** access token scoped to your own Vercel team, add it as the repo
  secret `TURBO_TOKEN`, and add the team slug as the repo **variable**
  `TURBO_TEAM` (both under Settings → Secrets and variables → Actions). The
  slug is not a secret, but it names an account, so it is a `vars` entry rather
  than a literal in the workflow — this repository is public. **Post-D-129 this applies to the
  local gate instead**: `pnpm gate` runs the same `turbo run typecheck` / `turbo
run lint`, so setting `TURBO_TOKEN`/`TURBO_TEAM` in the shell environment still
  buys the cache hits. Without them, turbo falls back to its local cache — never
  a hard failure.
- **The escalation ladder is retired: the repository is public, so the minutes
  are free** ([D-157](../decisions/D-157.md)). Every rung it used to list was
  premised on staying private — a self-hosted runner, pay-as-you-go overage,
  GitHub Team — and none applies while a public repo bills nothing for
  `ubuntu-latest`. ⚠️ **`ubuntu-latest` and nothing else**: a larger runner is
  billed by the minute even on a public repo, and a guard test fails on one.
  The self-hosting experiments this section used to narrate — an Oracle A1
  cloud runner, a paid Hetzner `self-hosted-x86` pool, a physical home mini-PC
  — are all reversed and their runbooks deleted
  ([D-164](../decisions/D-164.md)). The surviving arc is
  [D-119](../decisions/D-119.md) → [D-129](../decisions/D-129.md) →
  [D-157](../decisions/D-157.md) → [D-161](../decisions/D-161.md); the question
  is settled, so **do not re-derive it**.

### LLM — Anthropic API, pay-as-you-go

- **Why pay-per-use beats subscriptions for side-projects:** at this
  traffic, monthly LLM spend is in single dollars. A flat $20 plan
  loses.
- **Default to Haiku 4.5** for any task that doesn't need Opus-level
  reasoning (~$1 / 1M input tokens). Reach for Sonnet/Opus only when
  the task fails on Haiku.
  - **Caveat — Haiku 4.5 does not support `output_config.effort`.** It is a
    pre-4.6 model, so passing `effort` is rejected with a **400** (it works on
    Opus 4.5 at low/medium/high, and on 4.6+ models). A call site that passes
    `effort` cannot be moved to Haiku without dropping the parameter first.
    This has bitten twice: live captions (every utterance 502'd, subtitles
    silently blank) and the first draft of
    [D-87](../decisions/D-87.md) (would have 400'd every material
    generation). Check the call site before applying the default above.
- **One API key, one bill, one dashboard** across every side-project —
  no setup friction for new projects.
- **SpiralClass uses the API for AI class-content compose** — see the
  dedicated section below for the per-generation cost, how to read spend,
  and how to tune the monthly cap.

### Object storage — Cloudflare R2

- Already on **Cloudflare R2** (10 GB free, **zero egress fees**) for
  user uploads and lesson/call-audio artifacts.
- R2 is meaningfully cheaper than S3 at scale because of the egress
  pricing, so there's no cheaper tier to defer to — this is the
  end-state storage.

### Video — self-hosted LiveKit (Oracle A1, D-94)

- Previously the largest variable-cost vendor was never listed here at all
  (a real gap — see `docs/features/live-calls-video.md`). As
  of D-94, both preview and production run on a self-hosted LiveKit stack
  (`livekit-server` + `livekit-egress` + Redis + Caddy) on a free-tier Oracle
  Cloud "A1" ARM box (2 OCPU/12GB) — **$0/mo direct cost**, replacing
  LiveKit Cloud's participant-minute billing entirely.
- The real cost isn't zero, it's deferred: this box has no SLA and a
  documented Oracle free-tier suspension risk ([D-49](../decisions/D-49.md)),
  and its measured
  capacity ceiling is ~15-20 concurrent 2-participant rooms before packet
  loss (measured in the LiveKit spike; its runbook was deleted by
  [D-110](../decisions/D-110.md), the number is the part worth keeping) — now shared across both
  environments (D-94). The deferred cost is a purpose-built box (e.g.
  Hetzner CX22, ~$4.59/mo) once real concurrent load from a second/third
  teacher approaches that ceiling — see `ORACLE_LIVEKIT_PRODUCTION.md`'s
  "What this means going forward" for the exact graduation trigger.
- Recording storage rides the existing R2 line above (Egress uploads
  directly, no separate line item).
- Vendor keys for the AI-adjacent video features (Deepgram captions/ASR,
  Anthropic caption translation) are the same pay-as-you-go lines as the
  Anthropic section below — LiveKit itself no longer meters usage now that
  it's self-hosted.

### Analytics — skip until you need it

- Don't add PostHog / Plausible / GA until there's a question you
  can't answer without them. Free tiers exist (PostHog 1M events/mo)
  but adding them costs build time, page weight, and consent-banner
  complexity.

---

## Reusing this stack across multiple side-projects

| Service          | Cap per account                                    | Per-project isolation strategy                                    |
| ---------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Fly.io           | Unlimited apps per account                         | One app per side-project (pay-as-you-go per machine).             |
| Neon Free        | One project on the free tier (verify)              | One project per side-project — fresh free-tier quotas each.       |
| Sentry Developer | 1 user, multiple projects, **shared** 5k errors/mo | One project per app, watch the shared cap.                        |
| Resend Free      | Multiple domains, **shared** 3k emails/mo          | One verified domain per app, watch the shared cap.                |
| UptimeRobot Free | 50 monitors                                        | One monitor per app's `/api/health`.                              |
| Anthropic API    | Single account                                     | Separate API keys per app if you want per-project usage tracking. |

You can run ~5 small side-projects on this stack before any single
free tier starts pinching.

---

## When to actually start paying

Don't upgrade preemptively. Upgrade only when one of these triggers
fires, in priority order:

1. **Neon paid tier — ~$19/mo (verify).** Trigger: DB outgrows the
   free-tier storage/compute allowance **or** the project becomes
   load-bearing enough that a free-tier cold-start after summer break
   is unacceptable **or** you need more compute-hours / longer history
   / point-in-time recovery. This is almost always the _first_ paid
   upgrade.

2. **Fly.io paid usage — pay-as-you-go (verify).** Trigger: sustained
   traffic keeps machines running enough that the metered machine +
   bandwidth cost becomes non-trivial, **or** you need bigger/always-on
   machines, more regions, or a larger volume. There's no commercial
   restriction to trip here — it's purely a usage/spend threshold.

3. **Sentry Team — $26/mo.** Trigger: you hit 5k errors/mo (usually
   a sign something is broken, not a sign to upgrade). Or you want
   Sentry's built-in Uptime to consolidate alerts.

4. **Resend Pro — $20/mo.** Trigger: >3k emails/mo **or** you need

   > 100 emails in a single day (e.g. a launch announcement).

5. **Anthropic — already pay-as-you-go.** No "upgrade" — just
   monitor monthly spend in the dashboard.

**Total cost progression as a project grows:**

- Pre-launch / alpha: ~$1/mo (domain only)
- Launched, single classroom: ~$1–5/mo (domain + LLM usage)
- Sticky enough to need Neon paid: ~$20/mo (verify)
- Commercial + sticky: ~$40/mo (+ Fly paid usage) (verify)
- Real product: $70+/mo (all baseline paid plans) (verify)

The jump from $0 to $26 is where most side-projects die. Don't take
it until you have to.

---

## Project-specific notes for SpiralClass

- Domain (`spiralclass.com`) already registered.
- Fly.io apps provisioned (`agendaprofe` prod, `agendaprofe-preview`).
  Pay-as-you-go is correct for current scope (one teacher,
  friends-and-family alpha).
- Neon project provisioned. Free tier. ⚠️ **Free-tier auto-suspend
  cold-starts are the live risk** — a first request after a quiet period pays
  the wake-up. It has not bitten during a lesson, and it is the trigger that
  moves Neon to the paid tier first (see "When to actually start paying").
- Cloudflare R2 bucket provisioned for uploads / lesson audio.
- Sentry project provisioned. Developer tier.
- Resend is wired and its credentials are part of
  `assertProductionCredentials()` in `apps/web/src/lib/env.ts`, so production
  refuses to boot without them.
- **There is no external uptime monitor**, deliberately for now: `/api/health`
  exists and the production probes run as the last step of every deploy
  (`pnpm local synthetic`), which catches a regression at the moment one is
  introduced. What that does not catch is an outage between deploys. Pointing
  a free UptimeRobot or BetterStack check at
  `https://spiralclass.com/api/health` is the cheapest thing on this page and
  is not done.

---

## AI class-content compose (D-17)

The only place SpiralClass spends LLM tokens today is **AI class-content
compose** — the teacher's "draft this with AI" button on the class-content
panel. It calls the Anthropic API on the **platform** key only (never through
Connect), drafts Markdown the teacher reviews before saving, and is gated three
ways so spend stays bounded: the **Pro** entitlement, a per-call ceiling, and a
**per-teacher monthly cap**.

### What a generation costs

The call is `claude-sonnet-5` (override with `ANTHROPIC_MODEL`), `max_tokens:
4096`, `effort: "medium"`.

| Model              | Where                                           | Input / 1M                                 | Output / 1M               |
| ------------------ | ----------------------------------------------- | ------------------------------------------ | ------------------------- |
| `claude-sonnet-5`  | class-content / library compose                 | $3.00 (**$2.00 intro through 2026-08-31**) | $15.00 (**$10.00 intro**) |
| `claude-haiku-4-5` | lesson summary · insights · brief · intro coach | $1.00                                      | $5.00                     |
| `claude-opus-4-8`  | _(prior default on all five — for comparison)_  | $5.00                                      | $25.00                    |

> **Changed in [D-87](../decisions/D-87.md) (2026-07-19), as a
> per-surface split — not a blanket move.** All five customer-facing defaults
> were `claude-opus-4-8`. The four short, structured calls (lesson summary,
> insights, brief, intro coach — 1024–2048 `max_tokens`, no `effort`) went to
> `claude-haiku-4-5`, a flat **5× cut on both axes**. Class-content compose
> stayed a tier up on `claude-sonnet-5`: it is long-form customer-visible
> pedagogical output, the only streaming surface, the only one at `max_tokens:
4096` — and the only one passing `output_config.effort`, which **400s on
> Haiku 4.5**. That still cuts compose cost **~40%** vs Opus 4.8 (**~60%** at
> intro pricing). Read D-87 before treating "switch to a cheaper model" as an
> available lever — it has largely been pulled, and on compose the remaining
> step down is blocked by the `effort` constraint, not just by quality.

Rough envelope per generation (compose, on Sonnet 5 at standard pricing):

- **Input** is small — the prompt is the student's level label, up to ~25
  already-covered notebook titles, the student's name, and the instruction
  scaffold: on the order of 1–2K tokens, so ≈ **$0.003–0.006**.
- **Output** is bounded by `max_tokens` (4096) plus thinking; a full class plan
  runs a few thousand tokens, so ≈ **$0.03–0.06** at the ceiling.
- **Worst case ≈ $0.07 per generation** (≈ **$0.045** at intro pricing);
  typical is lower. These are _estimates_ — replace them with observed numbers
  once real usage exists (see below).

At the current cap that bounds a single teacher at **100 × ~$0.07 ≈ $7/month**
worst case (~$4.50 at intro pricing), down from ≈$15/month on Opus 4.8. With
one teacher (Alicia Moreno) that is the whole exposure; it scales linearly per Pro
teacher.

**Class content is the only capped surface.** Lesson summaries, insights,
briefs, and intro-video coaching call Anthropic on the same platform key with
no equivalent monthly ceiling. Those four are on Haiku after D-87 (a 5× cut on
their prior Opus cost), so the uncapped exposure got much cheaper — but if the
Anthropic bill surprises you, check the Console usage dashboard against _all_
of those surfaces — not just `class_content_generated`.

### How to read spend

Two independent sources:

1. **PostHog event `class_content_generated`** — captured once per _successful_
   generation (`apps/web/src/app/actions/class-content.ts`). Properties:
   `teacherId`, `bookingId`, `hasLevel`, `coveredCount`. Count this event over a
   window for generation volume, and break down by `teacherId` to find the
   heaviest users. **Caveat:** the event does **not** carry token counts or
   cost — it tells you _how many_ generations happened, not how many tokens they
   burned. For actual token/$ spend, read the **Anthropic Console** usage
   dashboard for the platform key over the same window and divide by the event
   count to get a real per-generation cost.
2. **`class_content_generations` table** — one row per successful generation,
   `(teacher_id, created_at)`. This is what the cap counts. It's the
   source of truth for "how close is teacher X to the cap this month":

   ```sql
   select teacher_id, count(*) as used_this_month
   from class_content_generations
   where created_at >= date_trunc('month', now() at time zone 'utc')
   group by teacher_id
   order by used_this_month desc;
   ```

   (The cap counts a **UTC** calendar month — `monthStartUtc()` in
   `src/lib/class-content/config.ts`.)

### Tuning the monthly cap

The cap is the named constant `CLASS_CONTENT_AI_MONTHLY_CAP` (currently **100**)
in `src/lib/class-content/config.ts` — change it there; the action, the panel,
and the tests all read from it. Guidance:

- **It's a spend ceiling, not a UX limit.** A teacher who hits it can still
  hand-author content — they just lose the AI draft for the rest of the month.
  Keep it generous enough that normal use never touches it.
- **Raise it** if the `used_this_month` query shows real teachers bumping the
  cap while per-generation cost (from the Console) stays low — the cap is
  costing UX more than it's saving dollars.
- **Lower it** only if observed cost per generation comes in much higher than
  the ~$0.03 estimate above, or if a single teacher's volume becomes a
  meaningful share of platform cost. Re-derive the target from
  `cap × observed_cost_per_generation × Pro_teacher_count` against whatever
  monthly LLM budget you're comfortable with.
- **Other levers before the cap:** the per-call `max_tokens` and `effort`
  (`config.ts` / `lib/ai/anthropic.ts`) bound a single generation's size;
  dropping `effort` to `low` or trimming `max_tokens` cuts the per-generation
  cost directly. **The cheaper-model lever is nearly spent** — D-87 already
  moved the four short surfaces to Haiku, the cheapest current tier, and
  compose to Sonnet 5. Compose cannot follow them down to Haiku: its call sites
  pass `output_config.effort`, which 400s on pre-4.6 models. Dropping `effort`
  from all four call sites in `lib/ai/anthropic.ts` (and the guard test in
  `tests/lib/env.test.ts`) would unblock a Haiku move — that is a code change
  with its own quality cost, not an env flip. In the other direction,
  `ANTHROPIC_MODEL` moves compose back up to Opus with an env change and no
  deploy (and only that surface — the lesson-notes and intro-coach constants
  are hardcoded and need a code change; see D-87's risks). **Also note the
  Sonnet 5 introductory pricing expires 2026-08-31** — compose cost rises ~50%
  on that date with no code change; re-check this envelope then.

## What to do when starting the next side-project

1. Buy domain.
2. New Fly.io app (same account).
3. New Neon project (fresh free tier).
4. New Sentry project (same org, watch shared error cap).
5. Add Resend domain (same account, watch shared email cap).
6. Add `/api/health` route. Add UptimeRobot monitor.
7. Re-use the same Anthropic API key (or create a new one per project
   for separate usage tracking).

Total setup cost: ~$12 (domain). Total monthly cost: $1 until usage
forces an upgrade.
