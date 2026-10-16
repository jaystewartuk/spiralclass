# Teacher setup: profile, listing, hours and calendar

What a teacher configures about herself: onboarding, her public booking page
and intro video, when she becomes publicly listed, her working hours, blocked
dates and Google Calendar sync. These decide the slots her students can book;
the booking rules themselves are [scheduling-booking.md](scheduling-booking.md).
Plan limits are [subscriptions.md](subscriptions.md); her account page (email,
export, deletion) is [account-settings.md](account-settings.md).

## Onboarding

Steps, in order (`/onboarding/...`): **reading** (text scale, spacing, tint),
**timezone**, **availability**, **templates**, **preview**.

The timezone step (`actions/onboarding.ts`, `timezoneSchema` in
`packages/shared/src/validators-core.ts`) requires:

- a valid IANA **timezone**;
- a **phone** number (8–15 digits, optional leading `+`), whose calling code
  is chosen independently of her country;
- her **country** (ISO 3166-1 alpha-2). It drives Stripe Connect eligibility
  ([payments.md](payments.md#rail-eligibility)). She can change it later at
  Settings → Account (`updateMyTeacherCountryAction`) only while no Stripe
  account is linked; Stripe fixes an account's country at creation;
- the subject she teaches, `teachers.target_language`, a code from
  `packages/shared/src/languages.ts`. It is not prefilled. It is asked here
  because her focus tags are seeded from it on first use and seeding is
  additive. It stays editable at Settings → Booking page.

Her **pricing currency** is picked here from the full curated list
(`PRICING_CURRENCIES`, `packages/shared/src/pricing-currency.ts`), preselected
from her country where a confident default exists. It is locked after
onboarding ([D-153](../decisions/D-153.md)). If none is picked, the column
default `DEFAULT_PRICING_CURRENCY` applies — a floor, not an assumption.

The templates step hides the per-package **Subject** field; Settings →
Templates shows it. Templates are covered in [packages.md](packages.md).

## Public listing (Marketplace Ready)

- Finishing onboarding does **not** make her public. The booking page
  (`/b/<slug>`), its buy page, social card, lead capture, anonymous checkout
  and the sitemap all gate on `isPubliclyListed()`
  (`apps/web/src/lib/marketplace-ready.ts`): `isMarketplaceReady()`
  (`packages/shared/src/activation.ts`) and not moderation-disabled.
- Marketplace Ready needs all six signals: onboarding complete, a photo, a bio,
  templates saved at least once (`templatesTouchedAt`), availability saved at
  least once (`availabilityTouchedAt`), and a payout rail (Stripe can charge,
  or a payout instrument is offerable in her pricing currency). The untouched
  starter templates do not count.
- Until then `/b/<slug>` returns 404 and Settings → Booking page names what is
  missing.
- It is the **only** activation state that changes behaviour; the others
  (`firstBookingReceived`, `activeTeacher`, …) are informational, and
  `marketplaceReadyAt` is an analytics cache no gate reads.
- **Not gated**: the teacher app itself, and existing relationships — a student
  who already has her keeps buying from the portal.
- The sitemap and the admin `stalled=yes` filter (onboarded at least
  `STALLED_TEACHER_DAYS` ago, still not ready) restate the predicate as a
  Prisma `where` by hand. A change to `isMarketplaceReady()` must be mirrored
  there.

## Intro video

- One short intro video on her booking page, recorded in the browser or
  uploaded. SpiralClass stores and serves the file into a `<video>` element —
  **never a YouTube/Vimeo/Loom embed** — because the coach, the transcript in
  the page's structured data and captions all need the media itself.
- It lives in a **public** R2 bucket (`lib/storage/teacher-video.ts`), one
  object per teacher, so a re-record replaces it; the URL carries a `?v=`
  cache-buster from the teacher row's `updatedAt`.
- Limit `MAX_VIDEO_BYTES` (50 MB) and about five minutes. Upload goes straight
  from the browser to R2 with a presigned `PUT`, which is why the CSP allows R2
  in `connect-src` and `blob:`/`https:` in `media-src` (pinned in
  `apps/web/tests/lib/csp.test.ts`).
- With `NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL` unset the editor card and the
  public video are hidden.
- **The AI coach** (Pro, `canUseIntroVideoCoach`; flag
  `INTRO_VIDEO_COACH_ENABLED` plus a speech-to-text key): an Inngest job on
  `intro-video.ready` transcribes the clip into `IntroVideoAnalysis`, then
  Claude writes feedback (`{overall, strengths[], improvements[]}`) shown
  **only to the teacher** in the booking-page editor, never on `/b/<slug>`.
  Feedback is best-effort; a failure keeps the transcript. It analyses only
  her own public clip, so it is outside the lesson-insights consent gate.
- Transcription uses her `teaching_language`; feedback is written in her
  `locale`. Never `target_language`.

## Working hours (Settings → Availability)

- Weekly recurring rules: weekday, start and end time, local time.
- At least one range; start before end; ranges on one weekday must not overlap
  (touching is fine).
- Each rule stores the timezone it was saved in; changing her account timezone
  later does not reinterpret it ([D-53](../decisions/D-53.md)).
- On the same screen: **rest between classes** (`bufferMin`, 0–120 minutes),
  **minimum notice** (`minAdvanceH`, 0–168 hours), **maximum advance window**
  (`maxAdvanceDays`, 1–365 days).
- Saving replaces the whole rule set in one operation.

## Blocked dates (Settings → Blocked dates)

- Whole local days, start to inclusive end; no time-of-day blocks and no
  recurrence. Start must not be after end; optional reason up to 120
  characters.
- Creating one cancels every overlapping scheduled class as a teacher cancel:
  the class goes back to the package and the student is told
  ([scheduling-booking.md](scheduling-booking.md#blocking-dates)).

## Google Calendar (Settings → Calendar)

- Optional, read-only: SpiralClass reads busy times and never writes events.
  Publishing her classes outward is the separate calendar-feed link.
- One connection per teacher. The consent request always asks for offline
  access (`prompt=consent`) so a refresh token is issued; a reconnect that
  returns none keeps the stored one.
- Busy times are pulled hourly (`sync-google-calendars-cron`) up to the
  smaller of her `maxAdvanceDays` and 60 days ahead. Each sync replaces the
  previous intervals.
- Busy times hide slots exactly like blocked dates, but **never cancel an
  existing booking**.
- She can pause sync or disconnect; disconnecting revokes access with Google
  (best effort) and deletes the imported intervals.
- A failed sync is stored on the connection (`lastSyncError`) and retried next
  run; she sees it on the Calendar settings page.
- Available on every plan, whenever the platform's Google credentials are
  configured.
- While the Inngest → pg-boss migration runs both job backends
  (`JOBS_BACKEND`, `lib/jobs/crons.ts`), the same idempotent sync is scheduled
  on each.

## Data

- **Teacher** — name, email, timezone, phone, country, pricing currency,
  `locale`, `teaching_language`, `target_language`, booking slug,
  headline/bio/photo/intro video, onboarding timestamp, `bufferMin`,
  `minAdvanceH`, `maxAdvanceDays`.
- **AvailabilityRule**, **BlockedDate** — see
  [scheduling-booking.md](scheduling-booking.md#data).
- **Google Calendar connection** — account email, sync enabled, last sync time
  and error; **Google busy intervals** — imported start/end instants.

## Permissions

Every item in this document is the teacher's own, edited only by her. Admins
can view teachers for support; they do not edit hours, blocked dates or the
calendar connection.
