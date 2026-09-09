# Feature: Teacher Subscriptions (SpiralClass Free / Pro)

## Overview

SpiralClass itself charges **teachers** a subscription to unlock the full
product — this is entirely separate from a teacher getting paid by her own
students (see `docs/features/payments.md`). A teacher account has exactly one
subscription record that resolves to a plan (**Free**, **Pro Monthly**, **Pro
Annual**, or **Founding**) and a lifecycle status, which together decide what
that teacher can do: how many students/package templates she can have, and
whether Pro-only features (class materials, live notes, custom pricing, intro
calls, the AI intro-video coach) are unlocked.

Every new teacher gets a genuinely usable **permanent Free tier** and a
**30-day full-Pro trial** with no card required. Nobody is ever locked out of
the product for non-payment — a lapsed/declined/canceled subscription always
falls back to Free, never to a disabled account. The platform's own billing
is charged directly on SpiralClass's Stripe account via **Stripe Billing**
(Customer/Price/Subscription/Invoice) — it is **never** routed through Stripe
Connect, and has its own separate webhook, distinct from the teacher-payout
webhook.

## User Stories

- As a **new teacher**, I want a real trial of the full product with no card
  required, so I can decide if it's worth paying for before committing.
- As a **teacher on Free**, I want to know exactly what I'm capped at (active
  students, package templates) and what upgrading unlocks, without ever
  losing data I already have.
- As a **teacher**, I want to subscribe monthly or annually (with a discount
  for paying annually), manage my payment method, and cancel any time without
  being charged again after the current period ends.
- As one of the **first teachers on the platform**, I want a shot at a
  cheaper price that's locked in for as long as I keep subscribing.
- As the **platform operator**, I want to comp specific accounts (internal,
  partners) to full Pro without ever billing them.
- As the **platform operator**, I want a lightweight way to pay an ambassador
  a referral commission without building a full referral/credit-ledger
  engine.

## Business Rules (exhaustive)

### Plans & pricing

| Plan           | Price  | Interval | Notes                                               |
| -------------- | ------ | -------- | --------------------------------------------------- |
| Free           | £0     | —        | Permanent, genuinely usable, not a locked-out state |
| Monthly (Pro)  | £7.99  | /month   |                                                     |
| Annual (Pro)   | £79.90 | /year    | Exactly 10× monthly (~2 months free)                |
| Founding (Pro) | £5.99  | /month   | Price **locked for life**, cohort-gated             |
| Comped (Pro)   | —      | —        | Internal flag, never billed, always full Pro        |

- Canonical billing currency is **GBP** as of **D-99** (2026). It was **MXN**
  before that (a Mexico-incorporation-era holdover). A pre-D-99 subscriber's
  actual billing currency is whatever is stored on their own subscription
  row, sourced from their real Stripe object — it is **never** reinterpreted
  or re-derived from "what's canonical today." Only brand-new checkouts
  resolve through the GBP price table.
- Money throughout is integer minor units (pence for GBP, centavos for MXN).
- This pricing/currency is entirely independent from what a teacher charges
  her own students (that's the teacher's own chosen marketplace pricing
  currency, default MXN, chosen once at onboarding — see D-64 and the
  Payments doc).

### Trial

- Every new teacher starts in `trialing` status with full Pro access for
  **30 days**, no card required (`TRIAL_DAYS`).
- **3 days before** the trial ends, the teacher gets a one-time "trial
  ending soon" notice (`TRIAL_ENDING_NOTICE_DAYS`).
- If the teacher hasn't subscribed by the time the trial ends, they fall to
  **Free** — never locked out, never a disabled account.

### Past-due grace

- If a recurring charge fails, the subscription enters `past_due` and the
  teacher **keeps full Pro** for a **7-day grace window**
  (`PAST_DUE_GRACE_DAYS`), with a persistent "update your payment method"
  banner.
- If the grace period elapses without a successful charge, the subscription
  drops to **Free** (again, never a hard lockout).

### Free-tier caps

- **Active students**: capped at **3** (`FREE_MAX_ACTIVE_STUDENTS`).
- **Package templates**: capped at **1** (`FREE_MAX_PACKAGE_TEMPLATES`).
- Pro (any paid plan, including while trialing or in past-due grace) is
  **unlimited** on both.
- **Downgrade never deletes data.** An already-over-cap teacher who drops to
  Free keeps every existing student/template/package fully functional
  (grandfathered, read-only against the cap) — she just can't **add** past
  the cap until she upgrades again.
- **The public self-booking/checkout flow is never gated by these caps** —
  a hard product rule is "never paywall getting paid." A Free teacher's
  booking page keeps accepting new students/purchases even over the nominal
  cap; the cap only blocks the teacher's own _deliberate_ adds (roster
  add-student, template creation).

### Pro-only features (all resolved through one entitlements function)

- **Class-materials scheduling** and **class-content authoring/AI compose**
  (`canScheduleMaterials`) — viewing existing materials/content stays free;
  authoring/scheduling new ones is Pro.
- **Per-student custom pricing** (`canCustomPrice`).
- **Live notes** — authoring notes is free on every tier; the **live**
  surfaces (present mode, the realtime student panel) are Pro
  (`canUseLiveNotes`).
- **Intro-video AI coach** (`canUseIntroVideoCoach`) — recording/showing the
  intro video is always free; only the AI transcription/coaching analysis is
  gated.

### Marketplace commission (tiered by subscription — separate from the plan price)

A percentage of the **settled Stripe net** is withheld before a teacher's
payout Transfer (see Payments doc), tiered by subscription standing:

| Standing                                       | Rate                 |
| ---------------------------------------------- | -------------------- |
| Free                                           | 8%                   |
| Pro (Monthly/Annual, including while trialing) | 3%                   |
| Founding (while effectively Pro)               | 0% (locked for life) |
| Comped                                         | 0%                   |

- A **lapsed** Founding subscription (canceled/expired, no longer effectively
  Pro) falls through to the ordinary Free rate like any other non-Pro
  teacher — the 0% rate is conditioned on currently being Pro, not merely on
  having once held the founding plan.
- **Wise payouts are structurally exempt** from this commission — the
  platform never touches Wise money, so Wise-only teachers are monetized via
  the subscription alone, not a commission cut.

### Founding cohort

- Open only while **both** hold: fewer than **50** teachers have ever taken
  the founding plan (`FOUNDING_MAX_TEACHERS`), **and** the current date is
  within **90 days** of the platform's launch date (`FOUNDING_WINDOW_DAYS`
  from `LAUNCH_DATE`). Whichever condition is hit first closes the cohort.
- The founding price is **locked for the life of that subscription** even if
  the config-table price changes later, or the currency changes (D-99): a
  subscriber's own stored `lockedPriceMinorUnits`/`currency` is authoritative,
  never re-derived from the table after activation.

### Lifecycle & status transitions

States: `trialing | active | past_due | canceled | free` (+ an orthogonal
`comped` boolean — a comped teacher can be `active` with `comped: true`; a
comped teacher is always treated as fully Pro regardless of status).

- New teacher (or every pre-existing teacher at the historical migration
  deploy) → `trialing`.
- Subscribes successfully → `active`.
- A charge fails → `past_due` (7-day grace, still full Pro).
- Trial ends unsubscribed, OR grace elapses unpaid, OR the teacher cancels →
  **`free`**. This is the only "downgrade" path; there is no separate
  suspended/disabled state for billing reasons.
- The **effective** status is computed live and clock-aware, not purely
  read off the database row: a `trialing` row whose `trialEndsAt` has
  already passed resolves to Free even before a scheduled sweep flips the
  row, and a `past_due` row whose grace window has elapsed likewise resolves
  to Free early. This defends against a lagging background job ever granting
  Pro past its actual expiry. It never works in the other direction — this
  computation never _upgrades_ a stale row.
- A missing/unknown subscription record resolves to Free — never an error,
  never a lockout.
- A background sweep drives the time-based transitions Stripe itself can't
  know about (the app's own no-card trial), plus the one-time "trial ending
  soon" nudge.

### Cancellation

- Canceling is **cancel at period end** — the teacher keeps Pro through the
  end of the period already paid for, then drops to Free. No proration is
  given for canceling mid-cycle.
- Stripe reports that window as an **`active` subscription carrying
  `cancel_at_period_end`**, not as a cancellation, and
  `teacher_subscriptions.cancel_at_period_end` mirrors it. That column is what
  lets the product tell "renews on the 14th" apart from "ends on the 14th":
  every other field on the row is identical in both cases. It is distinct from
  `canceled_at`, which is stamped only once the subscription has actually
  ended. Until the column existed the webhook parsed the flag and discarded it,
  and Plan & billing announced a "Next charge" to a teacher who had just made
  sure there would not be one.
- **The portal is declared in this repo, not in the Dashboard.**
  `apps/web/src/lib/stripe/portal-configuration.ts` is the source of truth for
  what a teacher can do in it — change card, switch Monthly/Annual, see her
  invoices, cancel at period end — and
  `pnpm --filter spiralclass-web stripe:portal:sync --apply` applies it and
  prints the id to pin in `STRIPE_BILLING_PORTAL_CONFIG_ID`. Before this,
  passing no configuration meant Stripe used a default it creates lazily on the
  first session from ITS defaults: the behaviour behind every "Manage billing"
  button was defined by nothing reviewable and changeable by any Dashboard
  click. Unset, the old lazy behaviour still applies — the variable is
  deliberately not part of `hasBillingCreds()`, because billing must not go
  dark over an unpinned portal.
- Between cancelling and the period end, Plan & billing says the plan **ends**
  on that date and offers **Resume subscription** (the same Customer Portal
  door). There is deliberately **no app-wide banner** for this state — she
  chose it, and following her around the product about her own decision is
  nagging. The banner is reserved for the two states that cost her something
  unless she acts: a running trial and a failed payment.

### Comped accounts

- A `comped` flag is fully independent of `status`/`plan` — it means "never
  billed, always full Pro," applied to specific internal/partner accounts by
  an admin action. Comped is idempotent to apply.

### Referral / ambassador commission (lightweight — not the full referral engine)

- A `?ref=CODE` link stamps attribution onto the referred teacher's account
  at signup — no codes ledger, no credit system.
- The commission report computes, per ambassador, a configured share of the
  **net** of every **paid** subscription invoice within the referred teacher's
  **first 12 months** (`COMMISSION_WINDOW_MONTHS`). ⚠️ **The share itself is
  deployment configuration** (`COMMISSION_RATE_PERCENT`), not a constant in
  this repository — it is the term of a private arrangement. Unset resolves to
  zero, so an unconfigured deployment reports a visible nothing rather than a
  plausible wrong number.
- Refunded/voided invoices are excluded from the commission base (clawback —
  an invoice that was refunded doesn't generate ambassador commission).
- A referred teacher who never upgrades past Free produces no invoices, so
  the referral earns the ambassador nothing.
- Paid **out-of-band** (a manual monthly transfer to the ambassador) — this
  is a reporting/export tool, not an automated payout rail.

### Manual/Wise subscription payment (phase-2, admin-only)

- The primary rail is Stripe Billing + its hosted Customer Portal (card
  update, cancel).
- A secondary manual rail exists for teachers who pay by transfer: an admin
  (finance role) can mark a billing cycle paid by hand
  (`markSubscriptionPaidManually`), recording a `provider: "wise"` invoice
  and activating the subscription for a 30-day period. This is an explicit
  admin tool, not a self-serve checkout — there is no automated Wise
  subscription-payment rail yet.

### Tax capture

- Both the subscription checkout and the student-payment checkout capture
  the payer's billing country/address regardless of whether tax is actually
  computed. A separate kill-switch (default off) turns on automatic tax
  calculation later with no need to backfill this already-captured data —
  that switch is a legal/business decision (VAT/GST registration), not a
  code change.

## User Flow

**New teacher onboarding:**

1. Teacher signs up → subscription row created in `trialing`, 30-day
   trial, full Pro, no card required.
2. Teacher uses the product freely for 30 days.
3. ~3 days before trial end, teacher is notified.
4. Trial ends: if not subscribed, teacher automatically drops to Free (no
   action required, no lockout — just reduced caps/features going forward).

**Upgrading to Pro:**

1. Teacher (on Free, trialing, or past_due) opens the billing/upgrade
   screen and picks Monthly, Annual, or (if the cohort is still open)
   Founding.
2. Redirected to Stripe's hosted checkout for the platform's own Stripe
   Billing product.
3. On successful payment, the subscription activates (`active`), with the
   plan's price locked onto the subscription row (permanently, for
   Founding).
4. Teacher can manage payment method / cancel any time via the Stripe
   Customer Portal.

**Payment fails on renewal:**

1. Subscription flips to `past_due`; teacher keeps full Pro and sees a
   persistent "update payment" banner.
2. If fixed within 7 days, the next successful charge returns the
   subscription to `active`.
3. If not fixed within 7 days, the subscription drops to `free`.

**Teacher cancels:**

1. Teacher cancels via the Customer Portal.
2. Pro access continues through the already-paid period; at period end the
   subscription becomes `free`. No partial refund/proration.

**Admin comps an account:**

1. Admin (finance role) uses the comp tool, choosing a plan label
   (defaults to founding) and an optional reason.
2. Subscription is activated with `comped: true` — always resolves to full
   Pro regardless of any future billing event; the action is logged to the
   audit trail.

## Data Used

- **TeacherSubscription** (one per teacher): plan, status, `comped` flag,
  `lockedPriceMinorUnits`, currency, Stripe customer/subscription ids,
  `trialEndsAt`, `currentPeriodEnd`.
- **SubscriptionInvoice** (one per billing cycle): rail-agnostic
  (`stripe`/`wise`), amount, fee, **net** (persisted explicitly — this is the
  ambassador-commission base), status, period start/end.
- **FoundingCohort**: single source-of-truth row tracking headcount and the
  cohort's cutoff/cap.
- **Teacher.referralSource**: nullable ambassador attribution stamped at
  signup.
- **Entitlements** (computed, not stored): plan, effective status, `isPro`,
  `isTrialing`, `isPastDue`, `comped`, the five Pro-feature booleans, student/
  template limits, and the marketplace commission rate — always derived live
  from the subscription row + current clock via the one resolver function,
  never read as raw DB fields elsewhere.

## Edge Cases

- **A teacher's trial ends at 2am while the nightly sweep hasn't run yet.**
  The effective-status computation resolves them to Free immediately based
  on the clock, regardless of whether the sweep has physically updated the
  database row — so no window exists where a stale row grants extra Pro
  time.
- **A Founding subscriber's plan lapses (cancels or fails through grace).**
  Their marketplace commission rate reverts to the Free rate, not the locked
  Founding rate — 0% commission is a _currently-Pro_ founding perk, not a
  permanent grant tied to having once subscribed as Founding.
- **The founding cohort closes mid-checkout** (50th teacher activates, or the
  90-day window passes) while another teacher is on the pricing page. The
  next checkout attempt for Founding should be refused; confirm the exact UI
  behavior (see Open Questions).
- **A pre-D-99 MXN subscriber renews after the platform's canonical currency
  switched to GBP.** Their renewal/upgrade math continues to use their own
  stored MXN price/currency — never silently re-priced into GBP.
- **A comped teacher is also billed** (shouldn't happen, but if a Stripe event
  arrived for a comped account) — comped teachers are treated as Pro
  regardless of `status`, so a stray billing event doesn't change their
  actual entitlements even if it updates other fields.
- **Downgrading to Free while over both caps simultaneously** (e.g. 6
  students and 3 templates on a lapsed Pro account) — both stay fully
  read-only-over-cap; the teacher can't add either until re-upgrading.
- **A referred teacher upgrades, then requests a refund on their first
  invoice.** The commission report excludes that invoice from the
  ambassador's payable total (clawback).

## Error States

- **Upgrade checkout attempted for Founding after the cohort has closed** —
  should be refused/hidden; exact user-facing message not confirmed in this
  pass (see Open Questions).
- **Stripe Billing webhook fails/misfires** — the effective-status
  computation's clock-based downgrade is the safety net that prevents a
  missed webhook from granting indefinite Pro access; it does not, by
  itself, ever _upgrade_ a teacher, so a missed "payment succeeded" webhook
  could leave a teacher wrongly on `past_due`/`free` until reconciled.
- **Admin comp/manual-paid actions require the `finance` admin role** —
  attempting either without it is rejected before any subscription row is
  touched.

## Permissions

| Action                            | Teacher (own) | Teacher (other) | Student | Admin (finance role) | Admin (other roles)    |
| --------------------------------- | ------------- | --------------- | ------- | -------------------- | ---------------------- |
| View own plan/entitlements        | Yes           | No              | N/A     | Yes (any teacher)    | Read-only, unconfirmed |
| Subscribe / change plan           | Yes           | No              | N/A     | No                   | No                     |
| Cancel own subscription           | Yes           | No              | N/A     | No                   | No                     |
| Comp a subscription               | No            | No              | No      | Yes                  | No                     |
| Mark a cycle paid manually (Wise) | No            | No              | No      | Yes                  | No                     |
| View commission report            | No            | No              | No      | Yes (implied)        | Unconfirmed            |

## Open Questions

- **Exact UI behavior when the Founding cohort closes mid-session** (does the
  option simply disappear, or does an in-flight checkout get rejected with a
  specific message?) — not confirmed from the code reviewed.
- **Which admin roles beyond `finance` can view (not act on) subscription
  data** — the comp/manual-paid actions explicitly require `finance`; broader
  read access wasn't traced in this pass.
- ~~**Is there a self-serve annual-to-monthly (or vice versa) plan-switch
  flow**~~ — **answered, and there is one now.** It was neither: the
  in-product grid is hidden for a paid subscriber (starting a second checkout
  would double-bill her, so `startBillingCheckout` refuses outright), and the
  portal had `subscription_update` disabled, so switching was reachable nowhere
  at all. The portal configuration this repo now declares enables it between
  **Monthly and Annual only**: an upgrade prorates immediately, and a downgrade
  is scheduled for the end of the period she has already paid for
  (`decreasing_item_amount`).
- ~~**Founding plan availability for an existing Monthly/Annual subscriber**~~ —
  **answered: never, by design.** Founding is reachable only through checkout,
  which is where `getFoundingCohortState` gates it on the cap and the cutoff,
  and it is deliberately excluded from the portal's switchable prices. All
  three plans are prices on one Stripe product, so naming that product would
  have let any subscriber move herself onto the £5.99 price past the cap, past
  the cutoff, and permanently — founding is price-locked for the life of the
  subscription. The exclusion is enforced in three places because Stripe's half
  of it cannot be read back: the declaration lists the two prices individually,
  a unit test asserts the founding id appears nowhere in the configuration, and
  the billing webhook logs an error if a subscription becomes founding while
  the cohort is shut. (The window closed on 2026-08-25 — launch plus
  `FOUNDING_WINDOW_DAYS` — so the plan no longer renders at checkout either.)
