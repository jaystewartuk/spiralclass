# Feature: Student Payments & Teacher Payouts

## Overview

This document covers a **student paying a teacher** for a class package (or a
single pay-at-reservation class), and the teacher then **getting paid out**
that money. It does not cover SpiralClass's own subscription billing to
teachers — that is a fully separate concern on the platform's own Stripe
account (`docs/features/subscriptions.md`).

Two payment rails exist side by side, and a student picks one at checkout:

- **Stripe Connect** (card payments) — using **direct charges** on **Accounts
  v2** ([D-143](../decisions/D-143.md)). **The teacher is the merchant of
  record and the platform never touches the money**: the charge is created on
  her own connected account, settles in her country at her country's card
  rates, and Stripe pays her out locally. There is **no Transfer**, and
  therefore nothing to reverse on a refund or a chargeback — both debit her
  balance directly.

  **No cut is taken at the charge** — no `application_fee_amount`. The old
  subscription-tiered marketplace commission is gone: cross-border
  application-fee support is undocumented, account-specific, and known to fail
  in exactly the markets the platform sells into. A take-rate remains
  available as a **billing** feature (meter GMV from the webhook, put it on
  her own subscription invoice, which works everywhere) and must never become
  a payments one again.

- **Manual transfer** — the student is shown the teacher's payee instructions
  plus a unique reference, sends the transfer directly to her (the money never
  touches the platform), self-attests with "Ya envié el pago", and the teacher
  confirms. The payment then runs the SAME `advancePayment` reducer Stripe
  runs, so activation, notification and analytics are identical either way.

  WHICH payee instructions is a separate axis, and the part that used to be
  conflated with the rail ([D-113](../decisions/D-113.md)): a teacher
  publishes one or more **payout instruments**, and each pending payment
  records the one its student was actually shown.

  | Instrument | What the student is given                             | Auto-reconcile                                               | Currency |
  | ---------- | ----------------------------------------------------- | ------------------------------------------------------------ | -------- |
  | **Wise**   | A prefilled `wise.com/pay/me/<handle>` Quick-Pay link | Yes, for teachers who connect their own Wise API credentials | Any      |

  Both rails are free on **every** subscription tier — "never paywall getting
  paid" is a hard product rule. Neither carries a commission: under direct
  charges the platform is not in the money path on Stripe either, so both are
  structurally exempt rather than only the transfer one.

### Wise is the only manual instrument, and why

⚠️ **There used to be a second kind.** `bank_account` held a per-country payee
format drawn from a **15-scheme registry** ([D-124](../decisions/D-124.md)) —
CLABE in Mexico, PIX in Brazil, NUBAN in Nigeria, IFSC in India, IBAN across the
roughly eighty registry countries and SWIFT/BIC as the universal fallback — so
that supporting a new country was a registry row rather than a migration. It was
good design for the problem as it stood.

[D-145](../decisions/D-145.md) removed it, with the kind, the registry
(`packages/shared/src/bank-schemes.ts`), its checksum validators, both settings
forms, three columns, four CHECK constraints and 120 i18n keys. **Do not
reintroduce it, and do not read D-124 as live policy.**

The reason it went is the interesting part. [D-143](../decisions/D-143.md) made
the teacher merchant of record on her own Stripe account, and that account began
presenting **SPEI** at checkout. So Mexico's bank transfer was being offered
twice on one page: once by Stripe, reconciling automatically, and once as a
`bank_account` instrument the student self-attested and the teacher confirmed by
hand. Same rail, two flows, different reliability, and no way for a buyer to
tell which one was "right". The worse copy goes.

`bank_account` was never merely slower. It was **permanently**
teacher-confirmed — no retail bank exposes a per-teacher statement API to
reconcile against, which D-124 recorded as a property of the instrument rather
than a gap that would close. Stripe closed it from the other side.

**Wise stays** because it is the one thing Stripe is not:

- it **auto-reconciles** through the teacher's own Wise API credentials, so it
  was never manual in the sense `bank_account` was;
- it is the fallback in the five countries Stripe refuses a merchant account
  (IN, ZA, NG, ID, IS) and everywhere outside the measured Connect countries;
- it still works if her Stripe account goes restricted.

**What is deliberately kept:** `PaymentRail.bank_transfer` (rows written before
the removal carry it) and the one-member `PayoutInstrumentKind` union — it is
what a second kind would return through, and dropping it would make
`teacher_payout_instruments.kind` a column that says nothing.

**Accepted costs**, stated in D-145: a teacher in IN/ZA/NG/ID/IS drops to one
rail; re-adding a country stops being a registry row and becomes a migration
again; and nobody measured the duplicate's conversion cost, so the case rests on
the shape of the page rather than on a funnel.

### What the instrument model means in practice

- **A closed union, not a payee-details builder.** Each kind gets typed columns,
  a CHECK constraint and per-kind application validation. **Never add a
  free-form payee-details field** — this rule outlived the registry it was
  written for. Every payee value a student pays against must be
  machine-checkable, because an unvalidated one on a page someone pays from is
  the single place this rail loses real money with no way back. If a second kind
  is ever added, it comes with a validator, not a text box.
- **Adding a KIND is a migration, on purpose.** That is the friction the closed
  union exists to impose.
- **`saveTeacherInstrument` is the only write path**, and it refuses to enable an
  incomplete instrument. `HAS_PAYOUT_RAIL_WHERE`'s SQL translation depends on
  that invariant holding.
- **The reference is the only matching key on a self-attested transfer.** A
  sender's free-text field gets truncated or mistyped. Wise's API reconciliation
  is what makes this rail workable; without connected credentials it falls back
  to `transfer-confirm-reminder` nudging the teacher, which is the only thing
  between a forgetful teacher and a student whose package never activates. The
  settings form says so before she enables it.

## User Stories

- As a **student**, I want to pay for a class package with my card or via a
  bank transfer, whichever is available and convenient for me.
- As a **teacher**, I want to receive the money my students pay directly, into
  my own account, without the platform standing between me and it.
- As a **teacher in a country Stripe will not take as a merchant** (India,
  South Africa, Nigeria, Indonesia, Iceland), I want a working payment rail
  anyway — and I want my own subscription to keep working too.
- As a **teacher**, I want to issue a full refund to a student when needed,
  and have both of us told it happened.
- As a **student**, I want to be told when a refund is issued, in the currency
  I was actually charged — not to discover it by finding my package marked
  "Reembolsado".
- As the **platform operator**, I want a payment dispute (chargeback) recorded
  against the teacher whose account bears it, and the disputed student's class
  credits revoked if the dispute is lost.
- As a **teacher**, I want a heads-up when my Stripe account needs attention
  (extra verification, payouts paused) so I don't discover it only when a
  payout fails silently.

## Business Rules (exhaustive)

### Rail selection & eligibility

- **The cross-border payout circle no longer binds this rail**
  ([D-143](../decisions/D-143.md)). It bound only because the platform made a
  Transfer, and there is no Transfer any more: under direct charges the charge
  is created on the teacher's own account, settles in her country, and Stripe
  pays her out locally. `SUPPORTED_CONNECT_COUNTRIES` is now the **measured**
  set of countries where a UK platform can create a v2 merchant account — 44
  of them, **including Mexico**, Brazil, Japan, Singapore, Thailand,
  Australia, New Zealand, Hong Kong, Malaysia and the UAE.
- **Widening that set is a measurement, not a judgement.** Stripe publishes no
  list; every code was probed against `POST /v2/core/accounts` in test mode
  with the config the app actually creates, before being added. Known
  refusals: **IN** (card_payments unsupported for the country), and **ZA**,
  **NG**, **ID** ("currently unavailable for your platform"). **Iceland is a
  deliberate absence** — it was inside the old circle and Stripe will not
  create a merchant account for it, so do not restore it on the assumption
  that EEA membership implies support.
- A teacher in a country outside that measured set falls back to **the manual
  transfer rail**, which is her only one. Country-based gating on the
  teacher's own country field is the single mechanism for this (a legacy
  manual per-teacher rail kill-switch was removed and must not be
  reintroduced).
- **Not being a merchant never blocks being billed.** A teacher Stripe refuses
  as a merchant (IN, ZA, NG, ID, IS), or one who simply has not connected
  yet, still gets a `customer`-configuration-only Account so her own
  subscription can be charged.
- A teacher can offer Stripe, the Wise instrument, both, or nothing — a student
  sees exactly the options she has enabled and finished setting up.
- An instrument is offerable when it is **enabled**, carries its kind's payee
  detail (a Wisetag), and can **settle the teacher's pricing currency**. Stripe readiness requires a connected Stripe account
  **with `charges_enabled` currently true**.
- If a student picks a rail the teacher isn't actually ready for, checkout is
  refused with a localized message before any rows are created (rather than
  failing deeper in the flow). The specific instrument is re-checked at submit
  as well as at render, so one disabled in between fails cleanly instead of
  leaving an orphaned pending package.

### Pricing at checkout

- The **grandfathered custom price** on the specific teacher–student
  relationship (if one is set) always wins over the template's catalog
  price, on **both** rails — there is no separate grandfathered transfer price.
  It is stored per package, per **pairing row** — `(teacher, student row,
template)`.
- **Every surface that shows a price and every surface that charges one must
  resolve that pairing row the same way**, through `purchasingLinkFor`
  (`lib/students/identity.ts`): the oldest non-archived pairing within the
  student's identity set. A signed-in student can own several Student rows
  (one per teacher, keyed by email), and "one row per (teacher, email)" is an
  app-level invariant rather than a database constraint — so a duplicate
  pairing is possible and both sides have to pick the same one. The portal
  used to price across the whole identity set while checkout priced from the
  pairing row alone, which is how a package could render at the teacher's
  agreed price, labelled "tu precio acordado", and then charge the catalog
  price at checkout.
- A **discount code** (a teacher promo code, or a per-student referral code)
  is resolved and applied _after_ the base/custom price, and composes last in
  the pricing stack — every downstream row (Package, Payment, the Stripe line
  item, and analytics) uses the final, post-discount amount.
- A discount that drives the price to **exactly zero** refuses the whole
  checkout with a clear message — a free class must be booked directly by the
  teacher, never sold as a $0 package.
- Card charges below the **currency-specific Stripe minimum charge** are
  refused before any row is created, with a message pointing the student at
  Wise if that rail is available for this teacher.
- Prices are always computed and stored in the **teacher's own chosen
  pricing currency** (see D-64) — never a hardcoded currency.

### Cross-rail double-charge guard

- Starting a new checkout **supersedes** any other still-pending checkout
  the same student has for the same template with the same teacher:
  - Any open Stripe Checkout Session is actively **expired** on Stripe's
    side (this is the step that actually prevents a late payment on the
    stale session) — the corresponding package is marked `expired` only
    if that expire call succeeds; if Stripe reports the session already
    resolved (paid or already expired), the old package is left alone
    rather than risk expiring a package that actually got paid.
  - A pending Wise checkout is simply marked `expired` — there's no hosted
    session to cancel, the reference just stops being offered.
  - **Exception**: a Wise checkout the student has already marked "I sent
    the payment" is **never superseded** — real money may be in flight, and
    superseding it would let a legitimate transfer land against a package
    that can no longer be activated.
- This exists specifically so a student can't end up with two payable
  checkouts (e.g. abandon a Stripe session, then try Wise) for the same
  purchase intent.

### Payment states & the state machine

- `Payment.status`: `pending → paid → refunded`, or `pending → failed`.
  `refunded` is terminal — no event can move a payment out of it.
- Stripe is **charge-or-fail** — there is no partial-payment/underpayment
  state on that rail. A settlement event reporting less than the expected
  amount is treated as a data-integrity failure and the payment is flipped
  to `failed`, not `paid` — the same treatment applies to a currency
  mismatch between what Stripe reports and what the row was priced in.
- A non-positive expected amount reaching the "flip to paid" step is treated
  as an unreachable invariant violation (an upstream bug), and throws loudly
  rather than silently activating a free package.
- A stale/duplicate/out-of-order webhook delivery **never demotes** an
  already-`paid` payment — e.g. a late "failed" or a currency-mismatched
  event arriving after a payment already flipped paid is a no-op, not a
  regression.
- Two concurrent webhook deliveries for the same underlying event (Stripe
  fires `checkout.session.completed` and `payment_intent.succeeded`
  separately for one purchase) race on a guarded conditional update keyed on
  the payment's pre-read status — exactly one delivery applies the
  transition (and its side effects: activating the package, enqueuing
  notifications); the other is a clean no-op.
- Wise confirmation reuses the **exact same** state-machine reducer as
  Stripe (a synthetic "succeeded" outcome is constructed for it), so the
  activate/notify/analytics behavior is identical across both rails by
  construction — they can't drift apart.

### Activation

- A `paid` payment's package is activated in one shared function used by
  both rails: sets `active` status, locks the purchase timestamp, and
  computes the expiry date from the template's expiration window
  (end-of-day in the teacher's timezone). Activation is idempotent — a
  package that isn't currently `pending` is left untouched.
- A Wise checkout that was superseded (marked `expired`) while a real
  transfer was quietly in flight is automatically **un-superseded** back to
  `pending` the moment that transfer is confirmed, so a legitimate late
  payment isn't stranded against a package that can no longer activate.

### Direct charges (the payout mechanism)

- The charge is created **on the teacher's own connected account**, with the
  `Stripe-Account` header — never on the platform's account
  ([D-143](../decisions/D-143.md)). She is the merchant of record. The money
  settles in her country at her country's card rates, and **Stripe pays her
  out locally**, on her own payout schedule.
- **There is no payout job, and no Transfer.** The previous design charged on
  the platform account, read the settled net back off the balance transaction,
  withheld a subscription-tiered commission, and forwarded the remainder. All
  of it is gone with `lib/payments/transfer.ts`; do not reintroduce a
  Transfer, a balance-transaction read-back, or a reversal-on-refund path.
  There is nothing left to reverse.
- **No `application_fee_amount`.** Cross-border application-fee support is
  undocumented, account-specific, and known to fail for exactly the markets
  the platform sells into. A take-rate belongs on her subscription invoice,
  not on her students' charges.
- The account carries **`merchant` and `customer` configurations on one v2
  `Account`**, with `fees_collector` and `losses_collector` both `"stripe"`.
  That is why v2 was worth a preview API: her Account IS the billing customer,
  so there is no Account-to-Customer mapping table to keep.
- **Wise and bank transfers were always outside this** — that money settles
  directly to the teacher and never touched the platform either.

### Refunds

- **MVP supports full refunds only** — no partial refunds from the app.
- A **teacher-initiated** refund is only available for a `paid` **Stripe**
  payment with a connected account and a recorded PaymentIntent; a Wise
  payment cannot be refunded through the app (it settled off-platform — the
  teacher would refund the student directly via Wise).
- Refunding always: (1) issues the real Stripe refund server-side, **as the
  teacher** — under direct charges the charge lives on her own connected
  account, so the refund debits her balance and there is nothing for the
  platform to claw back (D-143; the transfer reversal this step used to
  describe went with the transfer itself); (2) flips the payment to `refunded`
  and the package to `refunded` status, under a `status = paid` guard so a
  concurrent second refund is a no-op rather than a duplicate; (3) writes an
  audit-log entry with the stated reason; (4) voids any not-yet-redeemed
  referral reward that payment had qualified; and (5) **notifies the student
  and the teacher** that the money went back.
- **Steps 2 to 5 are one shared function**, `applyRefund` in
  `lib/payments/refund.ts`, used by every entry point that can refund. They
  had drifted apart when each had its own copy: none of them notified anybody,
  and the admin paths also skipped the referral clawback and the race guard. The student notice is the one that mattered
  most, because it is classed money-of-record and therefore cannot be
  silenced — it simply was never sent.
- A refund issued **from the Stripe Dashboard** directly (bypassing the app's
  refund button) is caught by the `charge.refunded` webhook and drives the same
  state flip, clawback and pair of notifications. The webhook keeps its own
  copy of that logic because it shares one state machine with the paid and
  failed transitions; `Payment.status = refunded` is terminal, so whichever
  path lands first wins and the other becomes a no-op — the money can never be
  refunded twice, and neither can the notice be sent twice.
- **A partial refund initiated from the Stripe Dashboard is deliberately
  ignored** by the webhook (`refunded: false` on the charge event) — treating
  it as a full refund would incorrectly revoke every remaining class on the
  package.
- Refunding is scoped to the teacher's own students/payments — a teacher
  cannot refund another teacher's payment.

### Disputes (chargebacks)

- Every dispute sub-event (`created`, `updated`, `closed`,
  `funds_withdrawn`, `funds_reinstated`, plus issuer-level warnings) is
  **upserted** into one row keyed by Stripe's dispute id, so the row always
  reflects the latest state regardless of how many events arrive.
- The dispute is matched back to the platform's own Payment/teacher via the
  PaymentIntent id when Stripe supplies one; a dispute Stripe can't tie back
  (rare — a raw charge outside the app's own flow) is still recorded, just
  unmatched, and flagged for manual ops review.
- **A dispute that is ultimately `lost`**: the disputed amount (plus a Stripe
  dispute fee) is pulled from **the teacher's** balance — she is the merchant
  of record and `losses_collector` is Stripe, so the platform is never out of
  pocket and has nothing to claw back (D-143). What still has to happen in the
  app is revoking the credits, since the student holds live classes paid for
  with a charged-back card: the payment flips to `refunded` and the package to
  `refunded`, and any unredeemed referral reward is voided. The flip is a
  guarded `updateMany`, so a redelivered `lost` / `funds_withdrawn` event is a
  no-op on the second pass.
- **Both sides are told** — `dispute_lost_student` and `dispute_lost_teacher`.
  This used to happen in silence: the student's package simply became
  "Reembolsado" with no notice, and the teacher, whose balance the money came
  out of, had only the ops alert below, which routes to Sentry rather than to
  her. The copy is deliberately **not** the refund copy. Nothing was refunded —
  the money did not go back voluntarily and the student's classes are gone
  rather than returned, so "refund issued" would be wrong about what happened
  to both of them. Neither version accuses anyone: a chargeback is raised with
  a card issuer, the outcome is the issuer's, and a genuine billing mix-up
  looks identical from here.
- A lost dispute on a charge that ties back to no payment row notifies nobody —
  there is no student or teacher to address. It is still recorded and flagged
  for ops.
- Every dispute event is also surfaced to the ops alerting channel, with
  severity scaled to how urgent it is: a `lost` dispute is the highest
  severity (money is already gone), a dispute that `needs_response` is
  elevated (every day of delay reduces the odds of winning it), everything
  else is informational.

### Stripe account connection status

- When a teacher's Stripe account transitions from **not able to
  charge → able to charge**, they get a one-time "you're ready to accept
  card payments" notice, and this is tracked as the "payout rail connected"
  analytics milestone.
- When a teacher's account transitions the **other** way (charges get
  disabled — e.g. Stripe needs more verification), they get an
  action-needed alert instead.
- Because Stripe can (and does) deliver the same `account.updated` event
  more than once, and can deliver two in close succession, only the
  delivery that actually wins an atomic conditional flip on the "was
  charges-enabled" prior value performs the transition/notification — a
  losing concurrent delivery is a clean no-op, so the milestone/notification
  fires **exactly once** per real transition, not once per webhook
  delivery.

### Abandoned checkout cleanup

- A pending Stripe checkout with no successful payment is hard-deleted
  (package + payment, cascading) after **7 days**.
- A pending Wise checkout gets a longer **14-day** grace window, since bank
  transfers and manual reconciliation take longer than a card charge.
- **A Wise payment the student has already marked "I sent it" is never
  auto-deleted**, regardless of age — that would destroy the only record of
  a transfer that may genuinely still be in flight or awaiting teacher
  confirmation.
- Every delete is guarded at delete-time (not just at scan-time) against a
  payment having settled in between — a payment that confirms/auto-reconciles
  in the gap between the sweep's scan and its delete is left alone rather
  than cascade-deleted out from under a student who just paid.

### Tax capture (not yet enforced)

- The student's billing country and full address are captured on Stripe's
  hosted checkout page regardless of whether tax is actually calculated —
  this is capture-only, preparing for VAT/GST support with no future
  backfill needed. Turning on actual tax calculation is a separate
  legal/business gate (the platform must be tax-registered first), not
  something this capture alone enables.

## User Flow

**Student buys a package (card):**

1. Student picks a package/template and Stripe as the payment method.
2. Server checks rail readiness, resolves final price (custom price →
   discount code), supersedes any other pending checkout for the same
   intent, and creates a `pending` Package + Payment in one transaction.
3. Student is redirected to Stripe's hosted Checkout page and pays.
4. Stripe webhook(s) confirm the charge; the payment flips to `paid`, the
   package activates (status `active`, expiry computed), and both student
   and teacher are notified.
5. Nothing further happens on the platform side. The charge was created on
   her account, so the money is already hers and Stripe pays it out on her
   own schedule.

**Student buys a package (Wise):**

1. Student picks Wise; server does the same pricing/supersede/pending-row
   steps, generating a unique, hard-to-guess payment reference.
2. Student is shown a prefilled Wise Quick-Pay link + the reference to
   paste, and sends the transfer directly to the teacher — money never
   touches the platform.
3. Student can click "I already sent it" (idempotent; only the first click
   notifies the teacher) while waiting for confirmation.
4. The teacher confirms receipt manually (or, if she's connected her own
   Wise API credentials, an automated reconciler matches the transfer by
   reference **and** amount off her balance statement — a reference match
   with a mismatched amount is never auto-confirmed, only surfaced for
   manual review).
5. Confirming flips the payment to `paid` through the same shared state
   machine Stripe uses; the package activates identically.

**Teacher issues a refund:**

1. From a paid Stripe payment's detail screen, teacher submits a reason.
2. Platform calls Stripe's refund API **as the teacher** (the charge is on
   her account, so the refund debits her balance — there is nothing to
   reverse), flips payment/package to `refunded`, logs the action, and voids
   any unredeemed referral reward.
3. Student and teacher are both notified of the refund.

**A card payment is disputed:**

1. Stripe notifies the platform of the dispute at every stage; the platform
   keeps one up-to-date row per dispute and alerts ops with severity scaled
   to urgency.
2. If the dispute is lost, the amount and the dispute fee come out of the
   TEACHER's balance (Stripe is `losses_collector`; the platform is not in
   the money path). The app flips the payment and package to `refunded`,
   revoking the student's remaining credits from that package, and voids any
   unredeemed referral reward.

## Data Used

- **Payment**: amount, currency, status, provider (`stripe`/`manual_transfer`),
  rail (`card`/`wise`/`bank_transfer`/`unknown` — `bank_transfer` is retained
  only for rows written before [D-145](../decisions/D-145.md)), the
  **instrument** this student was
  shown, Stripe PaymentIntent/Checkout Session ids, the app-generated
  `externalReference` (the idempotent lookup key), the manual-transfer
  reference and confirmation fields (who confirmed, when, auto-matched
  timestamp, student-marked-sent timestamp), refund provider id + timestamp,
  captured billing country/address, linked discount redemption / referral.
- **TeacherPayoutInstrument**: one row per kind per teacher — the payee
  details a student pays against (Wisetag and optional email), the `enabled`
  gate, and — for Wise only — the per-teacher API credentials the statement
  reconciler uses. A payment references the instrument rather than re-reading
  the teacher's current details, so confirming an old payment can never
  silently point at a payee she has since changed.
- **Package**: the thing being paid for (see Packages doc) — one-to-many
  with Payment (a superseded/retried checkout can leave more than one
  Payment row against a package).
- **Dispute**: Stripe dispute id, linked charge/PaymentIntent, matched
  Payment/teacher (nullable — an unmatched dispute is still recorded),
  amount, currency, reason, status, evidence-due date, whether the dispute
  is final.
- **WebhookEvent**: idempotency ledger for inbound provider events
  (Stripe, Inngest, LiveKit), tracking claimed-vs-processed so a redelivered
  event is recognized as a genuine duplicate only once fully handled.
- **Override (audit log)**: every refund and Wise manual-confirm is written
  here with a before/after snapshot and the actor's stated reason.
- **Teacher**: Stripe connected account id + charges/payouts-enabled flags,
  Wise handle + enabled flag, pricing currency, country (drives Connect
  eligibility).

## Edge Cases

- **A discount code drops the price to below Stripe's per-currency minimum
  charge.** Refused before any rows are created, with a message pointing at
  Wise if it's available for that teacher.
- **Student abandons a Stripe Checkout session, then retries via Wise for
  the same package.** The first session is actively expired server-side and
  its package marked `expired` — only the Wise attempt remains payable.
- **Student marks a Wise payment "sent," then the teacher never confirms
  it.** The payment is exempt from the 14-day abandoned-checkout cleanup
  indefinitely (not just extended) — it stays visible to the teacher to
  confirm/dispute manually.
- **A dispute event arrives for a charge the platform doesn't recognize**
  (e.g. a raw Stripe charge outside this flow). Still recorded, just
  unmatched to a teacher — flagged for ops rather than silently dropped.
- **A refund is issued from the app and from the Stripe dashboard at once.**
  `Payment.status = refunded` is terminal and every path flips it under a
  `status = paid` guard, so exactly one wins: one audit row, one referral
  clawback, one notice to each party. Stripe's idempotency key collapses the
  money movement itself.
- **Two webhook deliveries for the same underlying settlement event arrive
  concurrently.** Exactly one applies the paid/refunded/failed transition
  and its side effects (package activation, notifications); the other is a
  clean no-op — no double-notification, no double-activation.
- **A teacher's subscription tier changes between a purchase and her
  payout.** It makes no difference: no commission is withheld at the charge
  under direct charges, so a tier change cannot retroactively alter what a
  student's payment paid her.
- **A teacher outside the Stripe Connect circle (e.g. Mexico) somehow has a
  `stripeAccountId` from a prior era.** Country-based gating on the
  teacher's current country is the live mechanism; a previously-connected
  account for a non-circle country is a historical/migration edge case (see
  D-58 in the decision log for the one teacher this applied to).

## Error States

- **Checkout attempted for a rail the teacher isn't ready for** — refused
  with a localized message before any Package/Payment rows are created.
- **Student has no email on file and picks the Stripe rail** — refused
  (Stripe Checkout requires an email); the teacher-provisioned-student-with-
  no-email case is the only way to reach this.
- **Stripe isn't configured on this deploy at all** (missing platform
  credentials) — checkout fails soft with a "try Wise or come back later"
  message instead of a hard crash.
- **Refund attempted on a payment that isn't currently `paid`, isn't Stripe,
  or has no recorded PaymentIntent** — rejected with a specific error code
  per case (`not-paid`, `not-stripe`, `no-payment-intent`) surfaced back to
  the teacher's refund form.
- **Refund attempted by a teacher who isn't Stripe-connected** — rejected
  before calling Stripe at all.
- **Stripe itself rejects the refund call** — surfaced as a generic
  Stripe-error state on the refund form; nothing is flipped in the database.
- **Wise-confirm attempted on a payment that's already paid/refunded/failed,
  or that isn't actually a Wise payment** — rejected with a specific code
  per case rather than silently no-op'ing.
- **The settled balance transaction isn't available yet when the payout job
  runs** — the job throws so the caller (a retrying background job) tries
  again with backoff, rather than skipping the payout.

## Permissions

| Action                             | Teacher (own)                | Teacher (other) | Student (own purchase) | Student (other) | Admin                          |
| ---------------------------------- | ---------------------------- | --------------- | ---------------------- | --------------- | ------------------------------ |
| Start a checkout                   | N/A (students buy)           | N/A             | Yes                    | No              | No                             |
| Mark "I sent the Wise payment"     | N/A                          | N/A             | Yes (own payment)      | No              | No                             |
| Confirm a Wise payment as received | Yes (own students' payments) | No              | No                     | No              | Yes (support tooling, implied) |
| View own payments                  | Yes                          | No              | Yes (own)              | No              | Yes                            |
| Refund a payment                   | Yes (own, full refund only)  | No              | No                     | No              | Yes (support tooling, implied) |
| View disputes                      | Yes (own, implied)           | No              | No                     | No              | Yes                            |
| Connect/manage Stripe account      | Yes (own)                    | No              | No                     | No              | No                             |
| Connect/manage Wise handle         | Yes (own)                    | No              | No                     | No              | No                             |

## Open Questions

- **Is there a self-serve teacher-facing dispute-evidence submission flow**,
  or is evidence submitted directly in the Stripe Dashboard outside the app?
  The code reviewed only stores/tracks dispute state and alerts ops — no
  evidence-upload action was found.
- **What admin-facing tooling exists for confirming a Wise payment or issuing
  a refund on a teacher's behalf** (the permissions table above assumes
  support tooling exists at the admin level, mirroring the commission-report
  precedent in Subscriptions, but an explicit admin refund/Wise-confirm
  action wasn't directly located in this pass).
- **Partial refunds**: explicitly out of scope for MVP per the code
  comments — confirm this is still current before a QA pass assumes
  otherwise.
- **Automated Wise reconciliation dependency**: auto-matching requires a
  teacher to have connected her _own_ Wise Business API credentials: what
  happens for a Wise-only teacher who never does this (permanently
  manual-confirm-only), and is there any nudge to connect it?
