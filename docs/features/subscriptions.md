# Teacher subscriptions (Free / Pro)

SpiralClass charges **teachers** a subscription. It is separate from a teacher
being paid by her students ([payments.md](payments.md)). Each teacher has one
`TeacherSubscription` row; its plan, status and the clock decide what she can
do.

> [!IMPORTANT]
>
> - **The teacher's own v2 `Account` is the billing customer.** There is no
>   platform `Customer` object and no mapping table: subscriptions are created
>   with `customer_account`. `teacher_subscriptions.stripe_customer_id` means
>   "the thing we bill" and holds `acct_…` for everyone since
>   [D-143](../decisions/D-143.md). A teacher with no merchant account is still
>   billable.
> - **Subscription billing is a platform charge**: platform secret key, no
>   `Stripe-Account` header, its own webhook endpoint
>   (`/api/stripe/billing-webhook`) and secret (`STRIPE_BILLING_WEBHOOK_SECRET`).
>   A lesson payment belongs entirely to the teacher; never confuse the two.
> - **Never paywall getting paid** — both payment rails are free on every tier
>   — and **never delete teacher data on downgrade**; over-cap data is
>   grandfathered read-only.

## Plans

Prices and every number below live in
`packages/shared/src/subscriptions-config.ts`, re-exported for the app by
`apps/web/src/lib/subscriptions/config.ts`.

| Plan           | Price  | Interval | Notes                                                 |
| -------------- | ------ | -------- | ----------------------------------------------------- |
| Free           | £0     | —        | Permanent and usable; never a locked-out state        |
| Monthly (Pro)  | £7.99  | month    |                                                       |
| Annual (Pro)   | £79.90 | year     | 10× monthly                                           |
| Founding (Pro) | £5.99  | month    | Price locked for the life of the subscription; cohort |
| Comped (Pro)   | —      | —        | A flag, not a plan: never billed, always full Pro     |

- New checkouts price in **GBP** ([D-153](../decisions/D-153.md)). A subscriber
  billed in MXN before D-153 keeps the currency and price stored on her own row,
  taken from her Stripe objects; nothing re-derives them from today's table.
- Money is integer minor units.
- What a teacher charges her students is her own pricing currency and has
  nothing to do with this table.

## Trial and grace

- Every new teacher starts `trialing` with full Pro for `TRIAL_DAYS` (30), no
  card.
- `TRIAL_ENDING_NOTICE_DAYS` (3) before the end she gets one "trial ending"
  notice.
- A failed renewal sets `past_due`; she keeps full Pro for
  `PAST_DUE_GRACE_DAYS` (7) with an "update payment" banner.
- An unsubscribed trial end, an elapsed grace window, or a cancellation that
  reaches period end all drop her to `free`. There is no suspended or disabled
  billing state.
- A daily sweep (`subscription-sweep`, `lib/subscriptions/sweep.ts`) performs
  the time-based transitions Stripe does not know about and sends the
  trial-ending notice.

## Entitlements

`entitlementsFor()` is the one resolver
(`packages/shared/src/subscriptions-entitlements.ts`, imported in the app from
`apps/web/src/lib/subscriptions/entitlements.ts`). Never branch on plan or tier
anywhere else. The server gate is authoritative; a Pro lock shown before a
click is UX on top of it.

- **Effective status is clock-aware.** A `trialing` row past `trialEndsAt`, or
  a `past_due` row past its grace, resolves to Free before the sweep updates
  it. It never upgrades a stale row. A missing row resolves to Free.
- `comped` is independent of status: a comped teacher is always Pro.
- **Free caps**: `FREE_MAX_ACTIVE_STUDENTS` (3) active students and
  `FREE_MAX_PACKAGE_TEMPLATES` (1) active templates. Pro — including trialing
  and past-due grace — is unlimited.
- The caps block only the teacher's own deliberate adds (adding a student,
  adding a template). The public booking page and checkout are never gated, so
  a Free teacher keeps taking new students over the cap.
- **Downgrade deletes nothing.** Over-cap students, templates and packages keep
  working; she cannot add past the cap until she upgrades.
- **Pro-only capabilities**:

  | Entitlement              | Gates                                                                    |
  | ------------------------ | ------------------------------------------------------------------------ |
  | `canScheduleMaterials`   | Scheduling class materials and authoring/AI-composing class content      |
  | `canCustomPrice`         | Per-student custom prices                                                |
  | `canUseLiveNotes`        | Live-notes present mode and the realtime student panel (writing is free) |
  | `canUseIntroVideoCoach`  | The intro-video AI coach (recording and showing the video is free)       |
  | `canUseHomeworkAiReview` | The AI review draft of a homework submission (manual review is free)     |
  | `canSellForTwo`          | Switching on a package for two ([D-149](../decisions/D-149.md))          |

- Plans, caps and capabilities are code constants changed by pull request, not
  a database-editable matrix.

## Founding cohort

- Open while **both** hold: fewer than `FOUNDING_MAX_TEACHERS` (50) teachers
  have ever entered the founding plan, and the date is before `LAUNCH_DATE` +
  `FOUNDING_WINDOW_DAYS` (90). The `FoundingCohort` row holds the headcount and
  optional operator overrides of the cutoff and cap
  (`getFoundingCohortState`, `lib/subscriptions/service.ts`).
- The headcount only increases, so a lapsed founding subscriber's place is not
  returned to the cohort.
- With launch on 2026-05-27, the window closed on 2026-08-25 and Founding no
  longer renders at checkout. A Founding checkout attempted after the cohort
  closes is refused with `founding-closed`.
- The founding price is locked for the life of that subscription:
  `lockedPriceMinorUnits` and `currency` on the row win over the table.
- Founding is reachable **only through checkout**. It is excluded from the
  Customer Portal's switchable prices (the portal declaration lists the two
  other prices individually, and a unit test asserts the founding price id is
  absent), and the billing webhook logs an error if a subscription becomes
  founding while the cohort is closed. An existing Monthly or Annual
  subscriber cannot move to Founding.
- A founding subscription that lapses drops to Free, which clears the plan and
  the locked price. Resubscribing is a new checkout under whatever the cohort
  state is then.

## Checkout, portal and cancellation

- `startBillingCheckout` (`lib/subscriptions/start-billing-checkout.ts`) opens
  Stripe Checkout, hosted or embedded, for Monthly, Annual or (while open)
  Founding. It refuses a comped teacher (`already-comped`) and one with a live
  `active` or `past_due` subscription (`already-subscribed`) — a failed payment
  is fixed with a new card in the portal, not a second subscription.
- On success the subscription is `active` with the plan's price locked onto the
  row.
- **The Customer Portal is declared in this repository**:
  `apps/web/src/lib/stripe/portal-configuration.ts` (change card, switch
  between Monthly and Annual, see invoices, cancel at period end).
  `pnpm --filter spiralclass-web stripe:portal:sync --apply` applies it and
  prints the id to pin in `STRIPE_BILLING_PORTAL_CONFIG_ID`. Unset, Stripe's
  default portal applies; the variable is deliberately not part of
  `hasBillingCreds()`, so billing never goes dark over an unpinned portal.
- Switching Monthly → Annual prorates immediately; Annual → Monthly takes effect
  at the end of the paid period.
- **Cancellation is at period end**, with no proration. Stripe reports that
  window as an `active` subscription with `cancel_at_period_end`, mirrored in
  `teacher_subscriptions.cancel_at_period_end`; that column is what lets Plan &
  billing say "ends on" instead of "renews on". `canceled_at` is stamped only
  once the subscription has actually ended.
- While a cancellation is pending, Plan & billing shows the end date and
  **Resume subscription** (the portal). There is no app-wide banner for it;
  the banner is for a running trial and a failed payment.

## Operator tools (finance role)

In `apps/web/src/app/actions/admin-subscriptions.ts`, both requiring
`requireAdmin("finance")` and both writing an audit row:

- **Comp** (`markSubscriptionComped`) — activates the subscription with
  `comped: true` under a plan label (default founding), keeping her existing
  billing currency. Idempotent.
- **Mark a cycle paid by hand** (`markSubscriptionPaidManually`) — for a
  teacher who pays by transfer: records a `SubscriptionInvoice` with
  `provider: "manual"`, fee 0, and activates the subscription for 30 days at
  the amount entered. There is no self-serve transfer checkout.

## Ambassador commission

A teacher-referral arrangement, unrelated to the student referral program in
[referrals-discounts.md](referrals-discounts.md):

- `?ref=CODE` on the signup link is kept in a cookie and stamped on
  `Teacher.referralSource` when the teacher row is created.
- The commission report (`lib/subscriptions/commission.ts`) pays a share of
  the **net** of each `paid` subscription invoice in the referred teacher's
  first `COMMISSION_WINDOW_MONTHS` (12). Invoices in any other status are
  excluded.
- **The share is deployment configuration** (`COMMISSION_RATE_PERCENT`), not a
  constant here — it is the term of a private arrangement. Unset means zero,
  shown as zero.
- The report does not partition by currency; an operator checks an MXN/GBP mix
  by eye.
- It is paid out of band; the report is an export, not a payout rail.

## Data

- **TeacherSubscription** (one per teacher) — `plan`, `status`, `comped`,
  `lockedPriceMinorUnits`, `currency`, `stripeCustomerId`,
  `stripeSubscriptionId`, `trialEndsAt`, `currentPeriodEnd`,
  `cancelAtPeriodEnd`, `canceledAt`, captured billing country and address.
- **SubscriptionInvoice** (one per cycle) — period, amount, fee, `net`
  (stored; the commission base), currency, status (`paid` / `open` /
  `failed` / `void`), `provider` (`stripe` / `manual`), manual payment
  reference.
- **FoundingCohort** — headcount and optional cutoff/cap overrides.
- **Teacher.referralSource** — ambassador attribution.

## Edge cases

- **A missed "payment succeeded" webhook** can leave a teacher on `past_due` or
  `free` until reconciled; the clock-based downgrade never grants Pro on its
  own.
- **A stray billing event for a comped teacher** may update fields but cannot
  change her entitlements.

## Permissions

| Action                                                        | Teacher (own) | Admin (finance) |
| ------------------------------------------------------------- | ------------- | --------------- |
| View plan and entitlements                                    | Yes           | Yes             |
| Subscribe, switch, cancel                                     | Yes (portal)  | No              |
| Comp a subscription                                           | No            | Yes             |
| Mark a cycle paid manually                                    | No            | Yes             |
| View `/admin/subscriptions` (including the commission report) | No            | Yes             |
