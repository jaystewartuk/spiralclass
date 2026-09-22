# Referrals & Discounts

## Overview

SpiralClass gives teachers two related tools for growing and rewarding
their student base: **discount codes**, which a teacher can create and hand
out herself, and a **student referral program**, where an existing student
who refers a friend earns a reward for the teacher's business. The referral
program is built directly on top of the discount-code system — a
successful referral simply mints a special discount code as the reward,
rather than using a separate credit or cash mechanism.

A third, unrelated concept — the **founding-member cohort** — is a
platform-wide, time- and headcount-limited window in which new teachers can
lock in the cheapest, permanently price-locked subscription tier. This is
part of SpiralClass's own subscription plans (Free / Pro / Founding), not a
discount a teacher applies to her students; see
`docs/features/subscriptions.md` for full plan/pricing details. It's covered
here only from the angle of how the cohort window opens, closes, and
behaves on lapse.

A separate, informal **teacher-referral / ambassador arrangement** also
exists in the code (crediting whoever referred a new teacher with a
commission on that teacher's subscription revenue for a period), but it is
not wired to the discount-code or referral-program systems below at all,
has no self-serve UI, and is paid out manually/out-of-band. It is mentioned
here only so it isn't confused with the student referral program.

## User Stories

- As a teacher, I want to create a discount code (percentage or fixed
  amount off) that I can share with prospective students to encourage them
  to book.
- As a teacher, I want to limit how many times a discount code can be used
  in total and per student, and set it to expire automatically.
- As a student, I want to refer a friend to my teacher and have both of us
  get a discount once my friend actually pays for their first class.
- As a teacher, I want a referred friend's discount and my existing
  student's reward to come out automatically, without me having to
  manually create codes for every referral.
- As a teacher, if a referred payment gets refunded, I don't want to be on
  the hook for a reward that was never actually earned.
- As a new teacher signing up early, I want the option to lock in the
  cheapest ("Founding") pricing permanently, as long as the cohort is still
  open.

## Business Rules

### Discount codes

- Only teachers can create discount codes for their own students; there is
  no platform-admin surface for creating discount codes on a teacher's
  behalf.
- Codes are 3–40 characters, letters/numbers/hyphens only, must start with
  a letter or number.
- A code is either a **percent** discount (1–100%) or a **fixed-amount**
  discount — never both on the same code.
- A code can have a **total redemption limit** (unlimited by default) and a
  **per-student limit** (defaults to 1 use per student).
- A code can have an optional expiry date; past expiry it can no longer be
  redeemed.
- A redemption only counts against these limits while the associated
  package purchase is pending or active — if that purchase is later
  refunded or superseded, the redemption slot frees back up automatically.
- Discount codes apply only at the **teacher → student payment/package
  checkout** (i.e., when a student buys classes from her teacher). They do
  not appear to apply to SpiralClass's own platform subscription checkout
  (the Pro/Founding plans a teacher pays for) — see Open Questions.
- Only one discount code can be applied per checkout. A discount is applied
  after the base package price and after any per-student custom price
  override, and never brings the price below zero.
- A discount code can be "reserved" for one specific student (this is how
  referral rewards work, below) — to anyone else, a reserved code behaves
  as if it doesn't exist.

### Student referral program

- Each teacher opts in and configures her own referral program; it is off
  by default.
- The program has two independently configured rewards: a discount for the
  **referred friend's** first purchase, and a reward for the **referring
  student** once that purchase actually settles.
- A referral code is unique per (teacher, referring student) and is only
  generated the first time that student shares it — there's no code shown
  until then.
- Self-referral is blocked (a student can't refer themselves, whether by
  student ID or matching email), and referral discounts are first-purchase
  only — a friend who's already made a purchase can't retroactively apply a
  referral code.
- **The reward only fires once the referred payment actually settles**
  (card payment confirmed paid, or a Wise payment confirmed by the
  teacher) — never just on signup or code entry. At that point, the
  system automatically mints a discount code as the referring student's
  reward: usable once, reserved to that student only, and expiring after
  however many days the teacher configured (or never, if she left it
  unlimited).
- **Refund clawback**: if the referred payment is later refunded before the
  referrer's reward code has been used, the reward is deactivated and the
  referral is voided. If the reward was already redeemed by the time of the
  refund, the teacher simply bears that cost — it is not clawed back
  retroactively.
- The reward the referrer receives is always a discount code, never cash or
  an account credit balance — there is no credit-ledger concept in the
  product today (explicitly deferred, see Open Questions).
- There is currently no teacher-to-teacher referral/attribution feature
  built on this system — only student-to-student referrals exist.

### Founding-member cohort

- The founding cohort is capped at 50 total teachers and only open for 90
  days from SpiralClass's public launch date — whichever limit is hit
  first closes it.
- Once closed, no more teachers can select Founding pricing at checkout,
  regardless of headcount remaining.
- A teacher's founding price is locked in permanently for as long as she
  stays on the Founding plan — it is preserved through renewals.
- **If a founding member's subscription lapses or is cancelled, she loses
  founding status and pricing entirely** — there is no grace or "keep your
  rate" carve-out. If she resubscribes later, she does not automatically
  return to Founding (the cohort must still be open, and she'd be treated
  as a new selection).
- A teacher who upgrades into Founding from an existing Monthly/Annual plan
  gets the current Founding price, not a stale/inherited one.
- A lapsed founding member's cohort "slot" does not appear to be freed up
  for a new teacher to claim — the cohort headcount tracking only ever
  moves upward, so once 50 teachers have ever gone Founding, the cohort is
  effectively closed even if some of those teachers later lapsed. (Flagged
  as an Open Question below since no test explicitly confirms this is the
  intended behavior rather than an overlooked edge case.)

### Relationship between the systems

- The referral program is not a separate reward mechanism from discount
  codes — a referral reward literally _is_ a discount code (marked with a
  special origin so it's distinguishable in records), reserved to one
  student, limited to one use. Referral tracking (who referred whom, at
  what stage) is a thin attribution layer sitting on top of the same
  discount-code redemption path everything else uses.
- The founding-member cohort is unrelated to both of the above — it's a
  subscription-plan concept, not a per-checkout discount.

## User Flow

### Teacher creates a discount code

1. Teacher opens Discounts on the dashboard and creates a new
   code.
2. Chooses a code string, percent-or-fixed discount, optional total/
   per-student redemption limits, and optional expiry.
3. Shares the code with prospective students however she likes (social
   media, WhatsApp, etc.) — the product doesn't send it on her behalf.
4. A student enters the code at checkout; if valid, the discount is applied
   before payment.

### Teacher enables the referral program

1. Teacher opens Referrals and turns the program on, setting the referred
   friend's discount and the referrer's reward, plus how long a reward
   stays valid once earned.
2. An existing student shares her personal booking link/code with a friend
   (the code is generated automatically the first time she goes to share
   it).
3. The friend enters the code at checkout; validity, self-referral, and
   first-purchase rules are checked automatically.
4. Once the friend's payment actually settles, the system automatically
   creates a one-time discount reward for the referring student and emails
   it to her.
5. If that payment is later refunded before the reward is used, the reward
   is deactivated automatically.

### New teacher considers Founding pricing

1. During or shortly after signup, if the founding cohort is still open
   (under 50 teachers, within 90 days of launch), the teacher is offered
   the option to select Founding pricing at checkout.
2. If she selects it, her price is locked permanently at the Founding rate.
3. If the cohort has since closed, attempting to select Founding is
   rejected with a "Founding pricing is closed" message, and she proceeds
   with a standard plan instead.

## Data Used

- **Discount code**: code string, discount type (percent or fixed) and
  amount, total redemption limit, per-student limit, expiry date, whether
  it's reserved to one student, its origin (manually created by the
  teacher, or auto-minted for a referral).
- **Discount redemption**: which student used which code, on which
  package/payment.
- **Referral program settings** (per teacher): whether enabled, the
  referred friend's discount, the referrer's reward, reward expiry window.
- **Referral code**: one per (teacher, referring student).
- **Referral record**: status (attributed → qualified → rewarded, or
  voided), which package/payment it's tied to, the discount amount given to
  the friend, and a link to the reward discount code once minted.
- **Founding cohort state**: total teachers who have ever gone Founding,
  and (if the platform team has overridden them) a custom cutoff date or
  max-teacher count.

## Edge Cases

- A student tries to use her own referral code on herself, or on a friend
  whose email matches her own account — blocked as self-referral.
- A friend who's already made a purchase tries to apply a referral code
  retroactively — blocked (first-purchase only).
- Two discount codes attempted on the same checkout — only one code applies
  per checkout.
- A discount would reduce the price below zero — clamped at zero, never
  negative.
- A referred payment is refunded after the referrer's reward has already
  been redeemed — the reward isn't clawed back; the teacher absorbs the
  cost.
- A teacher disables her referral program after codes are already in
  circulation — previously issued codes' exact behavior for in-flight
  (not-yet-settled) referrals wasn't confirmed; see Open Questions.
- 50th teacher signs up right at the 90-day cutoff — whichever limit is
  reached first closes the cohort; a teacher arriving after either
  threshold cannot select Founding.
- A founding member cancels then re-subscribes — she does not automatically
  regain Founding pricing; she's treated as a new plan selection subject to
  whatever cohort state exists at that time.

## Error States

- Discount code creation: code format invalid (wrong length/characters),
  neither or both of percent/fixed amount set, percent outside 1–100.
- Discount code redemption: code not found (including a reserved code being
  looked up by someone other than its reserved student — treated the same
  as "not found"), code expired, total redemption limit reached, per-student
  limit reached for this student, code doesn't belong to the teacher on
  this checkout.
- Referral redemption: self-referral attempt, friend already made a prior
  purchase, referral program not enabled for this teacher.
- Founding checkout: cohort closed ("Founding pricing is closed") when
  headcount or time window has been exceeded.

## Permissions

| Action                                                     | Teacher (own program/codes) | Student   | Platform Admin                                             |
| ---------------------------------------------------------- | --------------------------- | --------- | ---------------------------------------------------------- |
| Create/edit/delete discount codes                          | Yes                         | No        | No (no admin surface found)                                |
| View discount redemption history                           | Yes (own codes)             | No        | Yes (via general subscription/money admin views)           |
| Enable/configure referral program                          | Yes                         | No        | No                                                         |
| Generate/share own referral code                           | No                          | Yes (own) | No                                                         |
| Redeem a discount or referral code at checkout             | N/A                         | Yes       | No                                                         |
| Select Founding plan at signup/checkout                    | Yes (own subscription)      | N/A       | No                                                         |
| View/adjust founding cohort cutoff or max-teacher override | No                          | No        | Yes (ops-level override fields exist on the cohort record) |

## Open Questions

- Whether discount codes can ever be applied to SpiralClass's own platform
  subscription checkout (the GBP Pro/Founding plans) — no such wiring was
  found, but this was inferred from absence of evidence rather than an
  explicit "not supported" rule. Confirm before stating it as a hard
  product limitation.
- Whether a lapsed founding member's cohort slot is ever reclaimed for a new
  teacher, or whether the 50-teacher cap is effectively permanent once
  spent (i.e., "50 people have ever gone Founding," not "50 people are
  currently Founding"). The cohort headcount as implemented only ever
  increases, suggesting slots are never reclaimed, but no test explicitly
  asserts this is intended rather than an overlooked edge case.
- Teacher-to-teacher referral/attribution and any account-credit-balance
  reward mechanism are explicitly deferred/not built — don't test for or
  document them as existing.
- The informal teacher-referral "ambassador" commission arrangement
  (crediting whoever referred a new teacher with a revenue share) has no
  self-serve UI and is paid manually outside the product — it's a distinct
  system from everything else in this document and shouldn't be conflated
  with student referrals in test planning.
