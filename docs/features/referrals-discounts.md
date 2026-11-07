# Discount codes and student referrals

A teacher can hand out **discount codes**, and can run a **student referral
program** in which a student who brings a friend earns a reward. The referral
program is built on discount codes: the friend's discount is applied like a
code, and the referrer's reward is a discount code minted for her alone. There
is no credit balance and no cash reward.

Two things that are not covered here:

- The **founding cohort** is a subscription plan, not a discount:
  [subscriptions.md](subscriptions.md#founding-cohort).
- The **ambassador commission** (a teacher who refers another teacher) is a
  subscription report:
  [subscriptions.md](subscriptions.md#ambassador-commission).

## Discount codes

Managed at `/dashboard/discounts` (`apps/web/src/app/actions/discounts.ts`,
`lib/discounts/`).

- Only a teacher creates codes, for her own checkout. There is no admin
  surface for them.
- A code is 3–40 characters, letters, digits and hyphens, starting with a
  letter or digit. Codes are matched case-insensitively (stored upper-cased).
- A code is **either** a percentage (1–100) **or** a fixed amount, in the
  teacher's currency.
- Optional total redemption limit (unlimited by default), a per-student limit
  (default 1), and an optional expiry date.
- A teacher can deactivate and reactivate a code, and delete one that has never
  been redeemed.
- **A redemption counts only while its package is `pending` or `active`.** A
  refunded, superseded or expired purchase frees the use again.
- The total limit is counted just before the checkout transaction, without a
  lock, so a burst of simultaneous checkouts can exceed it slightly (bounded by
  the checkout rate limits).
- Codes apply only to a student buying from her teacher
  ([payments.md](payments.md#pricing-at-checkout)), never to the teacher's own
  SpiralClass subscription checkout.
- One code per checkout, applied after the base price, the rail price and any
  custom price. The discount is clamped to the price; a result of zero refuses
  the checkout.
- **A discount is teacher-funded**: it is only a lower charge on her own
  account. The platform subsidises nothing.
- A code can be **reserved** for one student (this is how referral rewards
  work). To anyone else it behaves as if it does not exist.

## Student referral program

Configured at `/dashboard/referrals` (`saveReferralProgram`); off by default.

- Two rewards, set independently: a percent or fixed discount on the **referred
  friend's** purchase, and a percent or fixed reward for the **referring
  student**, with an optional validity in days (`rewardExpiryDays`; blank means
  it never expires).
- A student sees her share link in the portal (`/my-classes`) for each teacher
  she is actively rostered with whose program is on. The link is the teacher's
  booking page with `?ref=<code>`. Her code is unique per (teacher, student)
  and is minted the first time the link is shown. The prompt is emphasised
  after a lesson completed in the last 14 days; the platform never emails it.
- At checkout a typed code is tried as a promo code first, then as a referral
  code (`resolveReferralForCheckout`, `lib/referrals/index.ts`). A referral is
  refused when:
  - it is the student's own code, or the code owner's email matches hers
    (self-referral);
  - she already has a referral with this teacher on a `pending` or `active`
    package (one referred purchase per student per teacher; an abandoned or
    superseded attempt does not count);
  - the program is off or the code is inactive (shown as an invalid code).
- **The reward is minted only when the referred payment settles** (card paid,
  or Wise confirmed): the `grant-referral-reward` job qualifies the referral,
  mints a single-use code reserved to the referrer, and emails her. It is
  idempotent, and does nothing if the teacher has switched the program off in
  the meantime.
- **Refund clawback**: when the referred payment is refunded, or lost to a
  chargeback, an unused reward code is deactivated and the referral is voided
  (`voidReferralRewardForPayment`). A reward already redeemed is not clawed
  back; the teacher bears it.

## Data

- **DiscountCode** — teacher, code, kind (`percent` / `fixed`) and value,
  `active`, total and per-student limits, expiry, `reservedForStudentId`,
  origin (`promo`, `referral_referred`, `referral_referrer`).
- **DiscountRedemption** — which student used which code on which package and
  payment.
- **ReferralProgram** (per teacher) — enabled, the two rewards, reward expiry.
- **ReferralCode** — one per (teacher, referring student).
- **Referral** — status (`attributed` → `qualified` → `rewarded`, or `void`),
  the package and payment, the friend's discount, the minted reward code.

## Error states

- Creating a code: bad format, neither or both of percent/amount, percent out
  of range, expiry in the past.
- Redeeming a code: not found (including someone else's reserved code, or a
  code of another teacher), inactive, expired, total limit reached,
  per-student limit reached.
- Redeeming a referral: own code, already referred to this teacher, program
  off.

## Permissions

| Action                           | Teacher (own) | Student | Admin |
| -------------------------------- | ------------- | ------- | ----- |
| Create, deactivate, delete codes | Yes           | No      | No    |
| Configure the referral program   | Yes           | No      | No    |
| See and share own referral link  | No            | Yes     | No    |
| Redeem a code at checkout        | —             | Yes     | No    |
