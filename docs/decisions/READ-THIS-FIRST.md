# Two decisions, told in full

**In one paragraph, if that is all you have.** The payments architecture had
quietly absorbed somebody else's constraint — a UK company cannot send money to a
Mexican bank through Stripe — and had excluded Mexico rather than notice. The fix
was to stop needing the transfer at all: the teacher became the merchant, and
thirteen countries opened. Separately, the CI provider ran out of metered minutes
mid-month and took eleven days of production database backups with it before
anyone saw; all of it was deleted, and the three pieces that came back are only
allowed to _call_ the local checks, never to restate them.

Each of those reverses an earlier decision that was **not wrong when it was
made**. What expired was the premise, and the expensive part was the gap before
anyone noticed. That is what this log is for.

---

The rest of this page is those two at length — context, decision, what else was
considered, and what each one cost. There are 119 decision records
in this directory and these are two of them; every number below is from the
record it cites, and where a record states a cost it is repeated here rather than
smoothed over.

---

## 1. The teacher becomes the merchant of record

**[D-143](./D-143.md)**

### Context

SpiralClass took card payments through Stripe Connect using **separate charges
and transfers**: a student's money landed on the platform's own Stripe balance,
and a `Transfer` forwarded the settled net to the teacher's connected account.

That funds flow has a hard external constraint attached to it. A Transfer must
cross a border Stripe is willing to cross, and Stripe's cross-border payout
circle excludes Mexico — where the first teachers were. [D-58](./D-58.md) had
correctly concluded that a UK entity cannot Transfer to a Mexican connected
account, and had excluded Mexico from the card rail on that basis.

Two more problems shared the same cause. Which payment methods a checkout can
offer is decided by the **merchant's** country, so a UK platform charge cannot
offer OXXO or SPEI to a Mexican buyer at any price. And a dispute debited the
platform first, to be clawed back from a teacher who might already have
withdrawn.

### Decision

Stop being the merchant of record. The charge is created **on the teacher's own
connected account**, settles in her country, and Stripe pays her out locally. The
platform never holds, withholds or forwards any of it. Accounts move to Stripe's
Accounts v2 API with a full dashboard, `fees_collector` and `losses_collector`
both set to Stripe, so she pays her own country's rates and a chargeback debits
her balance.

**The error was never the payout circle. It was choosing a funds flow that
needed one.**

### Alternatives considered

- **Work around the circle with teacher-held third-party payment links** — a
  Wise link, a Mercado Pago _link de pago_, PayPal. This was the previous
  decision, [D-137](./D-137.md), which explicitly left Connect alone. It is
  rejected here because a direct charge makes the teacher merchant of record on
  Stripe itself: no second processor, no second dispute model, and no per-teacher
  link for someone to verify by hand.
- **Keep the platform commission at the charge.** Rejected on a measurement, not
  a preference: cross-border `application_fee_amount` support is undocumented,
  account-specific, and known to fail for exactly the markets this opens. A take
  rate remains available as a _billing_ feature — meter GMV from the webhook, put
  it on her own subscription invoice — because that works everywhere.
- **Infer the country list from Stripe's documentation.** Rejected in favour of
  probing. Every country code was tested against Stripe test mode with the exact
  configuration the application creates, before any of this was written.

### Consequences, including what it cost

- **44 countries accept the configuration. Four refuse** — India returns
  "card_payments capability is not supported for this account type"; South
  Africa, Nigeria and Indonesia return "v2 Account creation with
  configuration.merchant is currently unavailable for your platform".
- **Iceland was lost.** It was inside the old circle and Stripe will not create a
  merchant account for it. One country off the card rail against thirteen added —
  named in the constant and in its test, so nobody restores it on the assumption
  that EEA membership implies support.
- **The 8% and 3% marketplace commission was removed outright.** It only ever
  worked because the money passed through the platform balance.
- **Pix is unreachable, and Brazil was silently broken.** Stripe labels Pix
  "only supported in v1 accounts". Worse, `pix_payments` is not a v2 field at
  all, and v2 returns a 400 on an unknown capability name — so the entry in the
  registry was not a Brazilian teacher missing Pix, it was Brazilian account
  creation failing outright.
- **An active capability is only half the gate.** The first live teacher's
  account reported `oxxo_payments: active`, charges and payouts enabled, no
  requirements due — and her Checkout Session still came back card-only. What
  decides what Checkout offers is the connected account's payment-method
  configuration, inherited as a child of the platform's parent configuration,
  which had OXXO and Bank Transfers "off by default" and cannot be changed from
  code. **An account that looks perfectly healthy is silently card-only.**
- **A connected account, once created, can never be deleted.** Recorded in the
  addenda because it makes account creation an action with no undo.
- **The API version pin moved two years**, from `2024-06-20` to
  `2026-06-24.dahlia`. The record names this as the largest single source of
  regression risk in the change.

---

## 2. Every CI workflow is deleted — and the condition on which they came back

**[D-129](./D-129.md)** → **[D-157](./D-157.md)**

### Context

The repository was private, and GitHub Actions minutes are metered on a private
repository. [D-120](./D-120.md) had measured it: ~1,500–1,700 billable
minutes a month against a 2,000-minute allowance, the deploy alone ~744 of them.
Its own change brought that to roughly 780, comfortably inside the allowance, and
it concluded the scheduled work did not need to move.

Then the allowance emptied mid-month. Every private repository's workflows began
failing at once, and the one that mattered was the database backup.
**SpiralClass's production Postgres, holding live payment records, went eleven
days without a backup** while the public repositories stayed green and nothing
said otherwise.

### Decision

Delete all of it: fourteen workflows, four composite actions. Move the three cron
jobs to commands a person runs. Every run writes a receipt that keeps the last
run and the last _successful_ run separately, so a fortnight of red does not read
as fresh, and `pnpm gate` prints one line per overdue job — arriving at a moment
the operator is provably at the keyboard rather than in an inbox.

Ten days later (2026-08-25 → 2026-09-04, both dates in the records) the
repository went public, the minutes became free, and three workflows came back — **on one condition, which is the substance of both
records**:

> `scripts/ci/steps.mjs` stays the single definition of what "green" means.
> `scripts/fly-deploy.sh` stays the single definition of what a deploy is. The
> workflows **call** them. They never restate them.

### Alternatives considered

- **Keep the crons and accept the metering.** This is what D-120 decided, and the
  arithmetic behind it was right. What changed was not the arithmetic: it was
  that a backup whose availability depends on how many minutes the month's merges
  consumed is not a backup anyone can reason about.
- **Put the schedule on the laptop** — a launchd agent or a crontab. Rejected on
  D-120's own argument that a laptop schedule is one nobody owns. There is no
  scheduler; there are commands with a staleness nag attached, and the honest
  description of the cadence is "weekly, when prompted".
- **Bring the workflows back as they were.** Part of what was deleted was a
  dispatch-only copy of every check — a second definition of green that agreed
  with the first until the day it did not. Re-adding workflows re-opens exactly
  that hazard, so a guard test derives its forbidden-command list _from the
  registry itself_, and a check added there is covered the moment it lands.

### Consequences, including what it cost

- **Detection of production breaking on its own, between deploys, was genuinely
  lost.** A laptop cannot probe production while it is shut. The record states
  this plainly as accepted rather than solved; an external uptime probe remains
  the minute-cadence liveness signal underneath it.
- **The staleness nag is a warning and never part of the verdict.** A stale backup
  is not a reason to reject a commit, and a check that blocks unrelated work gets
  bypassed wholesale.
- **The better argument turned out not to be about money.** The deploy builds an
  `amd64` image; the operator's machine is arm64, so that build was a 20–30
  minute QEMU cross-build, described in its own header as flaky with threaded
  native addons. A GitHub runner is native `amd64`. D-157 says so directly: that
  is a better reason to move the deploy than the bill ever was, and it would have
  been a good reason while the minutes were still metered.

---

## What the two have in common

Each one is a decision that reverses an earlier decision **without the earlier
decision having been wrong**. D-58 was right that a UK entity cannot Transfer to
a Mexican account. D-120's minute arithmetic was right. In both cases what
expired was the premise, not the reasoning — and the expensive part was the gap
between when the premise died and when anyone noticed.

That is what this log is for, and it is why the reversals are kept alongside what
they reversed rather than replacing them.

If you want more: [the index](./README.md#start-here) groups the rest by the kind
of judgement each one shows.
