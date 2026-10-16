# Cost playbook

What each hosted dependency costs at this scale — one teacher and their
students, tens of monthly users — what keeps it near $0, and the order to start
paying in when usage demands it. The admin costs page and the expense vendor
list are structured from this file
(`apps/web/src/lib/money-metrics.ts`, `packages/shared/src/expenses-config.ts`).

Vendor prices and free allowances below are quoted from the vendors and
change; **verify before quoting one**.

## Summary

| Component           | Provider                          | Plan              | Monthly         |
| ------------------- | --------------------------------- | ----------------- | --------------- |
| Hosting             | Google Cloud Run                  | Always-free grant | $0              |
| Database            | Neon                              | Free              | $0              |
| Video               | LiveKit on a Compute Engine VM    | Always Free VM    | ~$3.65 (its IP) |
| Auth                | better-auth (in-app)              | n/a               | $0              |
| Storage             | Cloudflare R2                     | Free              | $0              |
| Error tracking      | Sentry                            | Developer         | $0              |
| Transactional email | Resend                            | Free              | $0              |
| Uptime monitor      | HetrixTools                       | Free              | $0              |
| CI                  | GitHub Actions, public repository | `ubuntu-latest`   | $0              |
| LLM                 | Anthropic API                     | Pay-as-you-go     | ~$0–7           |
| Domain              | Registrar                         | n/a               | ~$1 (≈ $12/yr)  |

## By component

### Hosting — Google Cloud Run ([D-184](../decisions/D-184.md))

- Scales to zero and bills compute, requests and egress past an always-free
  grant this traffic barely touches. D-184 carries the arithmetic; read it
  before re-deriving any of this.
- The two ways it stops being free — stored images and spend — are in
  [`infra/gcp/README.md`](../../infra/gcp/README.md).

> [!WARNING]
> Cloud Run has **no hard spending cap**: a crawl or a loop bills rather than
> throttles, and the budget alert in `infra/gcp/README.md` is what tells you.

- The price of scale-to-zero is a cold start, which the liveness monitor keeps
  away from real visitors
  ([`RELEASE_AND_STAGING.md`](./RELEASE_AND_STAGING.md#cloud-run-serves-production-d-184)).

### Database — Neon Free

- Serverless Postgres that scales to zero, with the branching and PITR that
  [D-178](../decisions/D-178.md)'s checkpoint relies on. The account's plan and
  why no paid plan was bought are in
  [`infra/database/neon/README.md`](../../infra/database/neon/README.md).
- **Compute auto-suspends** when idle and resumes on the next connection; the
  first request after a quiet period pays the wake-up. That, or outgrowing the
  free compute-hours, is the trigger that moves Neon to a paid plan first.

> [!WARNING]
> Any check against `/api/health` more often than every five minutes keeps
> Neon's compute awake and spends the free compute-hours. The uptime monitor
> stays on `/api/health/live`, which never queries the database.

### Video — LiveKit on Compute Engine ([D-16](../decisions/D-16.md))

- One Always Free `e2-micro`
  ([`infra/gcp-livekit/`](../../infra/gcp-livekit/README.md)). The only line on
  its bill is the static IPv4 address, about $3.65 a month. It carries a class
  but not egress, so class recording is off.
- **Graduation trigger:** two overlapping classes, which means an `e2-medium`
  — also the size that fits egress. D-16 and the module README carry the
  measurements and price.
- **The rollback is LiveKit Cloud's free tier**, kept as a commented line in
  `config/env/production.runtime.env`. It is a hard cap of 5,000
  participant-minutes a month (about 41 two-person class-hours), not a meter.
- **Captions:** recognised in the browsers for free. The paid fallbacks —
  Google Cloud Translation for translation and Deepgram streaming for two-phone
  calls — are priced in [D-185](../decisions/D-185.md).
- Recordings already in R2 ride the storage line below.

### Auth — better-auth (in-app)

$0. Auth runs inside the web app against the Neon database; the only email it
sends (magic link, OTP) goes through Resend.

### Storage — Cloudflare R2

Uploads and recorded lesson audio. 10 GB free and **zero egress fees**, which
is why it is the end-state storage rather than a tier to grow out of.

### Error tracking — Sentry Developer

5k errors and 10k tracing spans a month, one user. Sentry's own uptime checks
are a paid-plan feature; the uptime monitor is HetrixTools instead.

### Transactional email — Resend Free

3,000 emails a month, 100 a day, shared across the account's domains.
`assertProductionCredentials()` in `apps/web/src/lib/env.ts` refuses to boot
production without an email provider's credentials — Resend's, or Amazon
SES's, which `apps/web/src/lib/email/index.ts` prefers when both are set.

### Uptime monitor — HetrixTools Free

The check `spiralclass production liveness` hits
`https://spiralclass.com/api/health/live` about once a minute. It catches an
outage between deploys, which the post-deploy probes do not, and it is what
keeps a Cloud Run instance warm ([D-184](../decisions/D-184.md)).

### CI — GitHub Actions

$0 because the repository is public ([D-157](../decisions/D-157.md)).

- **`ubuntu-latest` only.** A larger runner bills by the minute even on a
  public repository; `apps/web/tests/config/local-gate.test.ts` fails on one.
- **Turborepo remote cache (Vercel's free tier):** `gate.yml` and `heavy.yml`
  read the `TURBO_TOKEN` secret and the `TURBO_TEAM` variable; set the same two
  in your shell and the local gate shares the cache. Without them turbo falls
  back to its local cache — never a failure.
- If the repository ever goes private again, the minutes stop being free;
  D-157 is written so that the reversal is deleting `.github/workflows/`.

### LLM — Anthropic API, pay-as-you-go

Every call uses the **platform** key, never a teacher's.
[D-87](../decisions/D-87.md) set the model per surface:

| Surface                                         | Model                                          | Where                                                                                  |
| ----------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Class-content and library compose               | `claude-sonnet-5` (override `ANTHROPIC_MODEL`) | `anthropicModel()` in `apps/web/src/lib/env.ts`                                        |
| Lesson summary · insights · brief · intro coach | `claude-haiku-4-5`                             | constants in `apps/web/src/lib/lesson-notes/`, `apps/web/src/lib/intro-video/coach.ts` |

> [!WARNING]
> **Haiku 4.5 rejects `output_config.effort` with a 400.** The compose call
> sites in `apps/web/src/lib/ai/anthropic.ts` pass `effort: "medium"`, so
> compose cannot move to Haiku without dropping the parameter first (and the
> guard in `apps/web/tests/lib/env.test.ts`). It has bitten twice: live
> captions and the first draft of D-87.

## AI class-content compose ([D-17](../decisions/D-17.md))

The teacher's "draft this with AI" button. It drafts Markdown the teacher
reviews before saving, and spend is bounded three ways: the **Pro**
entitlement, a per-call ceiling (`max_tokens: 4096`, `effort: "medium"`), and a
**per-teacher monthly cap**.

### What a generation costs

On Sonnet 5 at $3 / $15 per million input / output tokens:

- **Input** — the student's level, up to ~25 covered notebook titles, the
  student's name and the instruction scaffold: 1–2K tokens, ≈ $0.003–0.006.
- **Output** — bounded by `max_tokens` plus thinking: ≈ $0.03–0.06 at the
  ceiling.
- **Worst case ≈ $0.07 per generation**, so the cap bounds one teacher at
  about **$7 a month**, scaling linearly per Pro teacher. These are estimates;
  replace them with observed numbers.

**Class content is the only capped surface.** Summaries, insights, briefs and
intro coaching have no monthly ceiling. If the bill surprises you, check the
Anthropic Console against all of them.

### How to read spend

1. **PostHog event `class_content_generated`** — one per successful generation
   (`apps/web/src/lib/materials/handlers.ts`), with `teacherId`, `bookingId`
   and the prompt's shape. It counts generations, not tokens: divide the
   Console's spend for the same window by the count for a real
   per-generation cost.
2. **`class_content_generations` table** — one row per success, which is what
   the cap counts:

   ```sql
   select teacher_id, count(*) as used_this_month
   from class_content_generations
   where created_at >= date_trunc('month', now() at time zone 'utc')
   group by teacher_id
   order by used_this_month desc;
   ```

   The cap counts a **UTC** calendar month (`monthStartUtc()` in
   `apps/web/src/lib/materials/config.ts`).

### Tuning the cap

The cap is `CLASS_CONTENT_AI_MONTHLY_CAP` (**100**) in
`apps/web/src/lib/materials/config.ts`; the action, the panel and the tests
read it from there.

- **It is a spend ceiling, not a UX limit.** A teacher at the cap can still
  write content by hand. Keep it generous enough that normal use never touches
  it.
- **Raise it** if real teachers hit it while observed per-generation cost
  stays low.
- **Lower it** only if observed cost is well above the estimate above.
  Re-derive from `cap × observed cost per generation × Pro teacher count`.
- **Before the cap:** `max_tokens` and `effort` bound a single generation. The
  cheaper-model lever is nearly spent (D-87). `ANTHROPIC_MODEL` moves compose
  with an environment change and no code change; the four Haiku surfaces are
  constants and need a code change.

## When to start paying

Upgrade only when a trigger fires, in this order:

1. **Neon paid plan.** The database outgrows the free allowance, a cold start
   after a quiet period becomes unacceptable, or a longer restore window is
   needed. Almost always the first paid upgrade.
2. **LiveKit `e2-medium`.** Two overlapping classes (D-16).
3. **Cloud Run past the free grant.** Sustained traffic outgrows it, or
   always-on instances are needed; the budget alert says when.
4. **Sentry Team.** 5k errors a month is usually a sign something is broken,
   not a reason to upgrade.
5. **Resend Pro.** More than 3k emails a month or 100 in one day.

Anthropic is already pay-as-you-go: watch the monthly spend.
