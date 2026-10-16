# Student payments

A student pays her teacher for a package or a single class, and the money
reaches the teacher. SpiralClass's own subscription billing to teachers is a
separate system on the platform's Stripe account:
[subscriptions.md](subscriptions.md). What a package is and how its balance
moves: [packages.md](packages.md).

> [!IMPORTANT]
> **The teacher is the merchant of record and the platform never touches the
> money** ([D-143](../decisions/D-143.md)). Card payments are Stripe Connect
> **direct charges** on Accounts v2, created on her connected account with the
> `Stripe-Account` header, settling in her country at her country's rates.
> **Never set `application_fee_amount`**, and never reintroduce a Transfer, a
> balance-transaction read-back or a reversal-on-refund path — there is nothing
> to reverse. A take-rate, if ever wanted, is a **billing** feature metered from
> the webhook and put on her subscription invoice; never a payments one.

## The two rails

A student picks one at checkout.

- **Card (Stripe Connect)** — the charge is created on the teacher's own
  connected account; Stripe pays her out locally on her own schedule. Refunds
  and chargebacks debit her balance directly.
- **Manual transfer (Wise)** — the student is shown the teacher's payee
  details and a unique reference, sends the money to her directly, marks it
  sent, and the payment is confirmed by the teacher or by the teacher's own
  Wise API reconciliation. Confirmation runs the same `advancePayment` reducer
  Stripe events run, so activation, notifications and analytics are identical.

Both rails are free on every subscription tier — **never paywall getting
paid** — and neither carries a commission.

### Wise is the only manual payout instrument ([D-145](../decisions/D-145.md))

A teacher publishes **payout instruments**; a pending payment records the
instrument its student was shown. There is one kind:

| Instrument | What the student is given                             | Auto-reconcile                                               | Currency |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------ | -------- |
| **Wise**   | A prefilled `wise.com/pay/me/<handle>` Quick-Pay link | Yes, for a teacher who connects her own Wise API credentials | Any      |

- `PayoutInstrumentKind` stays an enum (a closed union) because it is what a
  second kind would return through. Adding a kind is a migration, on purpose.
- **Never add a free-form payee field.** Every payee value a student pays
  against must be machine-checkable, because an unvalidated one is the place
  this rail loses real money with no way back. A new kind comes with a
  validator, not a text box.
- **`saveTeacherInstrument`** (`lib/payments/save-instrument.ts`) is the only
  write path, and it refuses to enable an incomplete instrument.
  `HAS_PAYOUT_RAIL_WHERE`'s SQL translation depends on that.
- The **reference is the only matching key** on a self-attested transfer.
  Without connected Wise credentials the teacher confirms by hand, nudged by
  the transfer-confirm reminder (`lib/payments/transfer-confirm-reminder.ts`).
- **`pricing-fees.ts`** (`packages/shared/src/pricing-fees.ts`) is a
  deliberately generous estimate, used only to size the suggested Wise-rail
  discount. **Never present it as what Stripe charges** (D-143):
  teacher-facing copy names who charges the fee and links to Stripe's own page,
  and public marketing quotes no percentage. Guarded in
  `packages/shared/src/i18n/i18n.test.ts`.
- `PaymentRail.bank_transfer` survives only on rows written before D-145.
  "Bank transfer" is not a synonym for fee-free: a bank transfer made inside
  Stripe checkout is a Stripe payment and carries Stripe's fee. Copy names
  **Wise** as the rail that skips Stripe.

## Rail eligibility

- **`SUPPORTED_CONNECT_COUNTRIES`** (`packages/shared/src/countries.ts`) is the
  measured set of countries where the platform can create a v2 merchant
  account. Each code was probed against Stripe; widening it is a re-probe, not
  a judgement. Known refusals are listed in the constant's comment — IN, ZA,
  NG, ID and IS. Iceland is a deliberate absence; EEA membership does not imply
  support.
- A teacher outside that set has the Wise rail only. The teacher's own
  `country` is the single gating mechanism; there is no per-teacher rail
  kill-switch.
- **Not being a merchant never blocks being billed.** A teacher Stripe refuses
  as a merchant, or one who has not connected, still gets a v2 Account with
  the `customer` configuration so her subscription can be charged.
- A teacher can offer card, Wise, both, or neither; the student sees only what
  is enabled and complete. Card needs a connected account with
  `charges_enabled`. Wise needs the instrument enabled, a Wisetag, and support
  for the teacher's pricing currency.
- A rail the teacher is not ready for is refused with a localized message
  before any row is written. The chosen instrument is re-checked at submit as
  well as at render.

## Pricing at checkout

`lib/payments/start-checkout.ts` resolves the charge in this order:

1. The template's price for the rail (card price, or the non-card price on
   Wise), or the price for two.
2. A **grandfathered custom price** on the teacher–student pairing replaces a
   one-person price on both rails (`effectivePriceMinorUnits`,
   `lib/payments/grandfathered-prices.ts`); it never prices a package for two.
   It is resolved through `purchasingLinkFor`
   (`lib/students/identity.ts`) — the oldest non-archived pairing in the
   student's identity set — and every surface that shows a price resolves it
   the same way, so the page and the charge cannot disagree.
3. One **discount or referral code**, applied last
   ([referrals-discounts.md](referrals-discounts.md)). Every downstream row —
   Package, Payment, the Stripe line item, analytics — uses the final amount.

Then:

- A final price of **zero or less** refuses the checkout; a free class is
  booked by the teacher directly.
- A card charge below Stripe's per-currency minimum
  (`stripeMinChargeMinorUnits`) is refused before any row is written, with a
  pointer to Wise when the teacher offers it.
- Amounts are integer minor units in the teacher's own pricing currency
  (`currencyForTeacher`), never a hardcoded one.

### The language Stripe speaks

- Stripe's surfaces render in the language the checkout page was rendered in:
  `booking_page_locale` on the public funnel, the student's own locale in the
  portal — never the browser's.
- It is sent as the Checkout Session's `locale`, and as `preferred_locales`
  when the buyer's Customer is **created** (Stripe's receipt email follows the
  Customer). An existing Customer on the teacher's account is never rewritten.
- The teacher's own Stripe surfaces (subscription checkout, embedded
  onboarding in Settings → Payments) render in her app locale.
- The app-locale-to-Stripe mapping is `lib/stripe/locale.ts`; it is
  exhaustive, so a new app language does not compile until it is mapped.

### Cross-rail double-charge guard

Starting a checkout **supersedes** the same student's other pending checkouts
for the same template with the same teacher
(`lib/payments/supersede-pending.ts`):

- An open Stripe Checkout Session is **expired** on Stripe; its package is
  marked `expired` only if that call succeeds. If Stripe says the session
  already resolved, the package is left alone.
- A pending Wise checkout is marked `expired`.
- A Wise checkout the student has marked **sent** is never superseded. If one
  was superseded and its transfer is later confirmed, it is put back to
  `pending` and activated.

## Payment state machine

- `Payment.status`: `pending → paid → refunded`, or `pending → failed`.
  `refunded` is terminal.
- Card is charge-or-fail. A settlement event reporting less than the expected
  amount, or a different currency, flips the payment to `failed`, not `paid`.
- A non-positive expected amount at the flip-to-paid step throws rather than
  activating a free package.
- A late, duplicate or out-of-order event never demotes a `paid` payment.
- Concurrent deliveries for one purchase (`checkout.session.completed` and
  `payment_intent.succeeded`) race on a conditional update keyed on the
  pre-read status; exactly one applies the transition and its side effects.
- **Activation** (`lib/payments/activate-package.ts`), shared by both rails:
  status `active`, `purchasedAt` locked, expiry computed. Idempotent — a
  package that is not `pending` is left alone.

## Refunds

- **Full refunds only.** No partial refund from the app.
- A teacher can refund a `paid` **card** payment from its detail page
  (`actions/refund.ts`). A Wise payment settled off-platform; she refunds it
  in Wise herself.
- The refund is created on Stripe **as the teacher**, on her connected
  account, so it debits her balance and the platform has nothing to claw back.
- Everything after Stripe accepts the refund is `applyRefund`
  (`lib/payments/refund.ts`), shared by the teacher and admin
  (`actions/admin-payments.ts`) entry points: flip payment and package to
  `refunded` under a `status = paid` guard, void any unredeemed referral
  reward, and notify the student and the teacher (`refund_issued_student`,
  `refund_issued_teacher`). Each caller writes its own audit row.
- A refund issued **in the Stripe Dashboard** arrives as `charge.refunded` and
  drives the same flip, clawback and notices through the webhook's own state
  machine. Whichever path lands first wins; the other is a no-op.
- A **partial** Dashboard refund (`refunded: false` on the charge) is ignored,
  so it never revokes the whole package.

## Disputes

- Every dispute event is upserted into one `Dispute` row keyed by Stripe's
  dispute id, matched to a Payment and teacher through the PaymentIntent when
  possible. An unmatched dispute is still recorded.
- A **lost** dispute takes the amount and Stripe's dispute fee from the
  teacher's balance (`losses_collector` is Stripe). In the app, the payment and
  package flip to `refunded` under a guarded `updateMany` (a redelivered event
  is a no-op), any unredeemed referral reward is voided, and both sides are
  told (`dispute_lost_student`, `dispute_lost_teacher`). The copy is not the
  refund copy — nothing was refunded — and accuses no one.
- A lost dispute that matches no payment notifies nobody.
- Every dispute event goes to Sentry: `error` for lost, `warning` for
  `needs_response`, `info` otherwise. Operators see disputes at
  `/admin/disputes`; teachers have no dispute screen, and evidence is
  submitted in the Stripe Dashboard.

## Stripe account status

From `account.updated` (`lib/payments/webhook-handler.ts`):

- Charges disabled → enabled: `stripe_ready_teacher`, and the
  `payout_rail_connected` analytics event.
- Enabled → disabled: `stripe_requirements_teacher`.
- Only the delivery that wins a conditional flip on the previous
  `stripeChargesEnabled` value acts, so each fires once per real transition.

## Abandoned checkouts

`lib/payments/cleanup-pending.ts` hard-deletes pending checkouts (package and
payment):

- card, after 7 days; Wise, after 14 days;
- never a Wise payment the student has marked sent;
- re-checked at delete time, so a payment that settled after the scan is kept.

A teacher can also mark a pending Wise payment as failed
(`failWisePaymentAction`) when the student will not pay.

## Tax

`STRIPE_TAX_ENABLED` (default off, `lib/stripe/tax.ts`) decides whether Stripe
computes tax (`automatic_tax`) and whether the **student** checkout requires a
full billing address. Off, the student checkout uses
`billing_address_collection: "auto"` and the row keeps whatever partial address
Stripe collected; turning the flag on later cannot complete those rows. The
teacher's subscription checkout always requires a full address. Turning tax on
has legal prerequisites the flag does not enforce.

## What the teacher sees she earned (`lib/cashflow.ts`)

- **Earned** is money for classes taught: each class earns its package price
  divided by its class count. A no-show counts as earned.
- **Paid in advance** is money received for classes still to teach on
  packages that can still be redeemed. It counts priced packages only.
- **Classes still owed** on a package are `classesLeftToTeach()`
  (`lib/package-usage.ts`): unused classes plus booked-but-not-taught ones. A
  class lost to a late cancellation is used and not owed; classes recorded as
  used off-platform are not owed.
- **Amounts are what students paid.** The screens say card payments arrive
  lower after Stripe's fee, which SpiralClass does not receive. No net-of-fee
  figure is shown, and no figure is presented as safe to spend.
- **A class belongs to the month it was taught** (`scheduledStart`), with
  months cut in the teacher's timezone.
- The screen shows this month so far, what is booked for the rest of the month
  (real bookings on paid packages), last month once one is closed, earnings by
  month (up to `EARNINGS_HISTORY_MONTHS` back, empty months shown as zero, each
  split by student with largest-remainder rounding, plus the calendar-year
  total), and a typical month (mean and lowest of complete months, once two
  exist).
- Every figure is per currency, never blended.
- **Received** in the ledger is cash by payment date — a different measure
  from earned.
- Students an operator marked as test accounts are left out of a real
  teacher's figures but stay in her ledger, marked
  ([admin-portal.md](admin-portal.md#test-accounts)).

## The buy page (`/b/[slug]/buy`)

One column in the order a buyer decides: the chosen package (with Change), the
class-time picker (required for a single class, above the pay button;
optional for a package, after it), pay, then reassurance (photo, one
testimonial, the 24-hour cancellation promise), then the other rails behind a
closed disclosure.

- Slot times show in the **visitor's** timezone with the teacher's beside
  them.
- When `booking_page_locale` is `en`, an approximate USD figure appears beside
  the price (`lib/pricing/approx-usd.ts`, hidden once rates are older than
  `APPROX_MAX_AGE_DAYS`). The charge is always in her currency.
- Card checkout is Stripe's embedded form when
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is set, otherwise the hosted page.
- Wise checkout redirects to `/b/[slug]/buy/transfer/<reference>` with the
  Quick-Pay link and the reference. "I've sent it" is idempotent; only the
  first click notifies the teacher.

## Data

- **Payment** — amount, currency, status, `provider` (`stripe` /
  `manual_transfer`), `rail` (`card` / `wise` / `bank_transfer` / `unknown`),
  the instrument shown, Stripe ids, the app's `externalReference` (idempotent
  lookup key), the transfer reference and confirmation fields, refund id and
  time, captured billing country and address, linked discount or referral.
- **TeacherPayoutInstrument** — one row per kind per teacher: Wisetag,
  optional email, `enabled`, and the encrypted Wise API credentials. A payment
  references the instrument, so confirming an old payment never points at a
  payee she has since changed.
- **Dispute** — Stripe dispute and charge ids, matched payment and teacher
  (nullable), amount, currency, reason, status, evidence due date, `isFinal`.
- **WebhookEvent** — idempotency ledger for inbound Stripe, Inngest and
  LiveKit events.
- **Teacher** — `stripeAccountId`, `stripeChargesEnabled`,
  `stripePayoutsEnabled`, `pricingCurrency`, `country`.

## Error states

- Rail not ready → refused before any row is written.
- Card chosen for a student with no email (only a teacher-added student can
  lack one) → refused; Stripe Checkout needs an email.
- Stripe not configured on the deploy → a "card unavailable" message, not a
  crash.
- Refund refused with `not-paid`, `not-stripe`, `no-payment-intent` or
  `no-account`; a Stripe rejection shows `stripe-error` and changes nothing.
- Confirming a payment that is not a Wise payment → `not-wise`. Confirming one
  already paid, refunded or failed re-renders the page without an error.

## Permissions

| Action                         | Teacher (own)   | Student (own) | Admin         |
| ------------------------------ | --------------- | ------------- | ------------- |
| Start a checkout               | —               | Yes           | No            |
| Mark a Wise payment sent       | —               | Yes           | No            |
| Confirm or fail a Wise payment | Yes             | No            | No            |
| View payments                  | Yes             | Yes           | Yes           |
| Refund a card payment          | Yes (full only) | No            | Yes (finance) |
| View disputes                  | No              | No            | Yes           |
| Connect Stripe, manage Wise    | Yes             | No            | No            |
