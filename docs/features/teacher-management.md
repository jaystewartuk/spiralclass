# Teacher Management

## Overview

Teacher Management covers everything a teacher configures about herself and
her working schedule before and after she starts using SpiralClass: her
public profile and pricing setup, her weekly working-hours ("availability"),
one-off dates or windows she blocks off, and an optional connection to her
Google Calendar so external commitments automatically block bookable time.
These settings drive the slots that students see and can book on the
teacher's public booking page.

Teacher subscription entitlements (Free / Pro / Founding) are documented
separately in `docs/features/subscriptions.md`; this document only notes
where the features below interact with plan limits.

## User Stories

- As a new teacher, I want to set my timezone, phone number, country, and
  pricing currency once during onboarding so my booking page and payouts are
  configured correctly.
- As a teacher, I want to define my weekly working hours so students can
  only book classes when I'm actually available.
- As a teacher, I want to block off specific dates (a vacation, a holiday,
  a personal commitment) so students can't book classes during that time.
- As a teacher, I want any bookings that were already made during a period I
  just blocked off to be automatically cancelled and the affected students
  notified, without those students losing their paid class.
- As a teacher, I want to connect my personal Google Calendar so that events
  I already have scheduled there automatically block my SpiralClass
  availability, without me needing to double-enter them as blocked dates.
- As a teacher, I want to disconnect or pause Google Calendar syncing at any
  time without losing my other settings.
- As a teacher, I want to do all of the above from my phone as well as from
  a computer.

## Business Rules

### Profile / onboarding

- Required at onboarding: timezone (validated as a real IANA timezone) and a
  phone number (international format, 8–15 digits, optional leading `+`).
- Country (2-letter code) and pricing currency (3-letter code) are optional
  in the form but, once set, determine the teacher's payout rail:
  - Countries inside the Stripe Connect cross-border circle (UK, US, Canada,
    Switzerland, EEA) can price in GBP, USD, or EUR and use Stripe Connect
    payouts.
  - All other countries (including Mexico, the launch market) are Wise-only
    and price in MXN, COP, ARS, CLP, PEN, or BRL.
  - The phone number's country code is independent of the payout country —
    changing one does not change the other.
- Pricing currency is chosen once and is meant to stay fixed afterward,
  because existing packages/prices are already denominated in it. See Open
  Questions — no settings surface for editing it post-onboarding was found,
  but this hasn't been positively confirmed as blocked.
- Onboarding also captures working hours (see below) and package/pricing
  templates (subject to the Free-tier template cap — see subscriptions doc)
  before the teacher is marked as fully onboarded.

### Availability (working hours)

- Availability is a set of weekly recurring rules: day of week (Sun–Sat),
  start time, and end time (local time).
- A teacher must keep at least one availability range; the form rejects
  saving with zero ranges.
- A start time must be before its end time.
- Two ranges on the same weekday must not genuinely overlap. Ranges that
  merely touch (one ending exactly when the next starts) are allowed.
- Each availability rule also carries the timezone it was saved in. If a
  teacher later changes their account timezone, previously saved rules keep
  interpreting their times in the original zone — a timezone change doesn't
  retroactively reinterpret existing working hours.
- Three related scheduling settings are edited on the same screen:
  - **Rest between classes** (a buffer added after each class before the
    next slot can start): 0–120 minutes.
  - **Minimum advance notice** required to book: 0–168 hours (up to one
    week).
  - **Maximum advance window** a student can book ahead: 1–365 days.
- Saving availability is all-or-nothing: the whole set of rules is replaced
  in a single operation, not merged incrementally.

### Blocked dates

- A blocked date is a whole-day (or multi-day) range on the teacher's
  calendar, specified as a start date and an inclusive end date — there is
  no time-of-day granularity (e.g., you can't block "just the afternoon");
  the entire local day(s) are blocked.
- The start date must not be after the end date.
- An optional reason can be attached, up to 120 characters.
- There is no recurring blocked-date concept — every blocked date is a
  one-off entry.
- **Automatic cancellation of collisions**: if a teacher creates a blocked
  date that overlaps one or more already-scheduled bookings, those bookings
  are automatically cancelled as a teacher-initiated cancellation. The
  affected student's class is restored to their package (they don't lose
  the class they paid for), an audit record is kept, and the student is
  notified that the class was cancelled.

### Google Calendar connection & sync

- Connecting Google Calendar is optional and read-only: SpiralClass only
  reads busy/free time from the teacher's Google Calendar; it never creates,
  edits, or deletes events in it. (Pushing SpiralClass classes _out_ to any
  external calendar is a separate feature — a subscribable calendar feed
  link — not the Google Calendar connection.)
- Only one Google Calendar connection is allowed per teacher.
- Connecting requires the teacher to complete a Google consent screen; the
  connection is deliberately forced to always request a refresh token so
  syncing can continue in the background.
- A teacher can pause syncing without fully disconnecting (a sync
  on/off toggle), and can fully disconnect at any time, which best-effort
  revokes access with Google and deletes all imported busy-time data.
- Reconnecting without granting a fresh refresh token (e.g. a repeat
  consent) keeps using the previously stored refresh token rather than
  failing.
- Busy time is imported for a rolling window of up to 60 days ahead (capped
  at whichever is smaller: the teacher's own "maximum advance booking
  window" setting, or 60 days).
- Each sync fully replaces the previously imported busy intervals — it does
  not merge or diff against the prior sync.
- Busy time imported from Google is treated identically to a manually
  blocked date when computing which slots are bookable — a student simply
  never sees those times as available.
- If a sync fails (e.g. an expired/revoked token), the failure is recorded
  silently against the connection (with a short error message) rather than
  interrupting anything else; syncing is retried on the next scheduled
  cycle.
- The Google Calendar feature only appears/works when the platform has
  Google API credentials configured for this integration — it is not gated
  by subscription plan (Free and Pro teachers both have access to it, when
  enabled platform-wide).

### Entitlement gating in this area

- Availability rules, blocked dates, and Google Calendar sync are **not**
  restricted by subscription plan.
- The only plan-gated item that intersects onboarding in this feature area
  is the number of package/pricing templates a teacher can save (Free-tier
  cap) — see the subscriptions documentation for the exact limit and
  upgrade behavior.

## User Flow

### First-time onboarding

1. Teacher signs in for the first time and is routed into onboarding.
2. **Timezone & contact step**: teacher confirms/sets timezone, enters phone
   number, and optionally sets country and pricing currency (currency
   choices are filtered to whichever rail her country supports).
3. **Availability step**: teacher sets buffer time, minimum notice, maximum
   advance window, and at least one weekly working-hours range per day she
   teaches.
4. **Templates step**: teacher sets up her class/package pricing templates
   (capped on Free plan).
5. **Preview step**: teacher reviews her public booking page before
   finishing.
6. Onboarding is marked complete; the teacher's booking page becomes fully
   live.

### Editing working hours later

1. Teacher opens Settings → Availability.
2. Adjusts buffer/notice/window values and/or adds, edits, or removes
   weekly time ranges.
3. Saves; the entire rule set is validated (no overlaps, at least one
   range) and replaced.

### Blocking a date

1. Teacher opens Settings → Blocked Dates.
2. Chooses a start date and an end date (and optionally a reason).
3. Saves. If any existing bookings fall inside the blocked range, those
   bookings are cancelled automatically, the affected students' packages
   are credited back the class, and the students are notified.

### Connecting Google Calendar

1. Teacher opens Settings → Calendar and chooses to connect Google
   Calendar.
2. Teacher is sent to Google's consent screen (read-only calendar access)
   and approves.
3. Teacher is returned to SpiralClass; the connection is shown as active,
   labeled with the connected Google account's email.
4. Busy time starts syncing automatically on a recurring schedule (roughly
   every 15 minutes) going forward, up to ~60 days ahead.
5. Teacher can toggle syncing off/on, or fully disconnect, from the same
   screen at any time.

## Data Used

- **Teacher profile**: name, email, timezone, phone number, country,
  pricing currency, locale, teaching/target language, booking page slug,
  headline/bio/photo/intro video, onboarding-completion timestamp.
- **Availability rule**: one weekday, a start time, an end time, and the
  timezone it was authored in.
- **Scheduling settings**: buffer minutes, minimum advance notice hours,
  maximum advance booking days.
- **Blocked date**: a start and end instant (spanning whole local days) and
  an optional reason.
- **Google Calendar connection**: the connected Google account's email,
  whether syncing is enabled, the last successful sync time, and the last
  sync error (if any).
- **Imported busy time**: a list of start/end instants pulled from Google,
  refreshed on every sync.
- **Booking / package data**: read (not owned by this feature) to detect
  collisions when a blocked date is created, and to compute bookable slots
  together with availability rules and imported busy time.

## Edge Cases

- Teacher tries to save availability with zero ranges — rejected, must keep
  at least one.
- Teacher creates two ranges on the same day that overlap (not just touch)
  — rejected.
- Teacher blocks a date range that already has bookings inside it — those
  bookings are auto-cancelled with the student made whole (class restored),
  not silently orphaned.
- Teacher's Google Calendar sync discovers a new busy interval that lands on
  top of an already-booked (SpiralClass) class — see Open Questions; this
  does not appear to trigger the same auto-cancel-and-notify behavior that a
  manually created blocked date does.
- Teacher relocates and changes her account timezone — previously saved
  availability rules keep their original recorded timezone rather than
  being reinterpreted.
- Teacher disconnects Google Calendar — all previously imported busy
  intervals are deleted immediately, potentially opening up slots that were
  previously blocked by synced events.
- Google token expires or is revoked outside SpiralClass (e.g. teacher
  revokes access from her Google account settings) — sync silently fails
  and records an error; the teacher isn't necessarily proactively alerted in
  the moment it happens (visible only when she checks the Calendar settings
  screen for a "last sync error").
- Platform-wide Google API credentials are not configured — the whole
  Google Calendar connection feature doesn't appear at all, on either
  platform.

## Error States

- Onboarding timezone step: invalid/unsupported timezone value, invalid
  phone format, unsupported currency for the selected country.
- Availability save: no ranges provided, invalid time range (end before or
  equal to start), overlapping ranges on the same day, out-of-bounds
  buffer/notice/window values.
- Blocked date save: end date before start date, reason exceeding 120
  characters.
- Google Calendar connect: OAuth flow expired/invalid state (must restart
  connect flow), Google denies/cancels consent, token exchange failure.
- Google Calendar sync: expired/revoked refresh token, Google API errors —
  both surface as a stored "last sync error" rather than a blocking failure
  elsewhere in the product.

## Permissions

| Action                                              | Teacher (own profile/settings) | Student             | Platform Admin                                                            |
| --------------------------------------------------- | ------------------------------ | ------------------- | ------------------------------------------------------------------------- |
| View own profile/onboarding data                    | Yes                            | No                  | Yes (moderation/support)                                                  |
| Edit profile (timezone, phone, etc.)                | Yes                            | No                  | Limited (support escape hatches only, not this feature's day-to-day path) |
| Create/edit/delete availability rules               | Yes                            | No                  | No                                                                        |
| Create/edit/delete blocked dates                    | Yes                            | No                  | No                                                                        |
| Connect/disconnect Google Calendar                  | Yes                            | No                  | No                                                                        |
| Toggle Google Calendar sync on/off                  | Yes                            | No                  | No                                                                        |
| View another teacher's schedule settings            | No                             | No                  | Yes (support/moderation context)                                          |
| View resulting bookable slots (public booking page) | Yes (own)                      | Yes (any teacher's) | Yes                                                                       |

## Open Questions

- Is there actually any way for a teacher to change her `country` or
  `pricingCurrency` after onboarding completes? The code's intent is that
  these are locked in place once payout setup begins, but no settings
  screen exposing an edit path was confirmed either way during this
  investigation.
- When Google Calendar sync discovers a new busy interval that overlaps an
  already-scheduled SpiralClass booking, does that trigger the same
  automatic cancellation + student notification + package credit-back that
  a manually created blocked date does? Evidence suggests it does not (the
  cancellation logic appears wired specifically to the blocked-date-creation
  path), which would mean a Google sync could silently make a slot look
  unavailable in the future without touching an existing booking sitting on
  top of it. This should be confirmed with the team — it materially affects
  what teachers should expect.
- Google Calendar sync currently appears to be scheduled from two places
  (a background job scheduler and a separate periodic job definition), both
  roughly every 15 minutes. Is this intentional redundancy/failover, or is
  one of them legacy and safe to remove?
