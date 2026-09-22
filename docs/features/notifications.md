# Notifications

## Overview

SpiralClass keeps teachers and students informed of everything that happens
in their classes, bookings, payments, and messages through a system-generated
notification pipeline. Every notification is produced by the product itself
(there is no user-facing "send a notification" action) and is delivered
through up to two channels — **push** (browser Web Push) and **email** — plus
an always-created **in-app inbox entry**.

The system's defining behavior is **push-first delivery**: for most
notification types, the app tries push first and only falls back to email if
push isn't available or fails. A small set of notification types — anything
tied to money, billing, or signing in — bypasses this and always sends both
push and email, because those must never be silently missed. Chat messages
use a still different, third pattern (see
[Distinction from chat notifications](#distinction-from-chat-notifications)).

Both teachers and students can turn categories of notifications on/off and
choose which channels they want for each category — with the exception of
the non-suppressible types above, which cannot be turned off by anyone.

## User Stories

- As a student, I want to be reminded before my class starts.
- As a student, I want to know immediately if my teacher cancels or
  reschedules a class.
- As a student, I want to know when new class materials or homework feedback
  are available, without being spammed if I've already seen it in the app.
- As a teacher, I want to be notified when a student books, cancels, or pays
  for a class, and when a payout or subscription issue needs my attention.
- As a teacher or student, I want to control which kinds of notifications I
  receive and through which channel (push, email, or both), except for
  things like payment confirmations, which I should never be able to
  accidentally silence.
- As a teacher, I want a brand-new student who hasn't started using the app
  yet to not be bombarded with notifications before they're actually ready.
- As a user, if a push notification fails to reach my browser, I still want to
  find out by email rather than never learning about it.

## Business Rules (exhaustive)

### Channels and delivery modes

- Two delivery channels exist: **push** and **email** (Resend). There is no
  WhatsApp channel (removed).
- **`push` has ONE transport: browser Web Push**, to a signed-in web session
  that has turned notifications on for that device.
  - ⚠️ It had two. The second was removed: no device could hold one of its
    tokens any more, so it was calling a real external API on the hot dispatch
    path for rows that could only come back `DeviceNotRegistered`. The table it
    delivered against was dropped with it.
    **The lesson is worth more than the cleanup**: removing a client silently
    retires every affordance whose transport it was — the in-class nudge button
    had been delivering nothing and reporting "Sent" for a month.
  - `push` remains one `notification_channel` enum value with the transport as
    an implementation detail. This is load-bearing: per-category preferences
    store an `allowedChannels` allow-list (`["push","email"]`), so a new enum
    member would have been absent from every existing row and silently excluded
    for every current user.
  - Subscriptions live in `web_push_subscriptions`, keyed by the endpoint URL
    the browser's push service mints. They are soft-revoked (`revoked_at`) when
    the push service reports one permanently gone (HTTP 404/410); a transient
    failure (429/5xx/network) never revokes.
  - **Delivery is confirmed synchronously.** A Web Push send stamps
    `delivered_at` at dispatch and mints a `webpush:<notificationId>` provider
    id.
  - **Web Push requires a VAPID keypair** (`VAPID_PUBLIC_KEY`,
    `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). With any of them missing the
    transport is simply absent: stored subscriptions do **not** count toward
    push-reachability, so those recipients fall to email rather than having a
    doomed push attempted on every dispatch. Rotating the PUBLIC key
    invalidates every existing browser subscription — it is baked into the
    subscription the browser minted.
  - **On iPhone and iPad, Web Push only exists once the site is installed to
    the Home Screen.** In a normal Safari tab `PushManager` is absent entirely,
    so the UI detects iOS and says "add to Home Screen first" rather than the
    flatly wrong "your browser doesn't support notifications".
- An in-app inbox entry is effectively always recorded for every
  notification produced, independent of whether push/email succeeded — read
  state (`readAt`) is tracked separately from delivery status and is only
  set when the recipient actually opens it in the inbox.
- **The inbox shows the last 90 days only.** Both the list and the unread
  badge are filtered to a rolling 90-day window, so an inbox stays short on
  its own without the recipient having to tidy it. This is a visibility
  window, **not** a deletion: older notification records stay in the
  database permanently as the delivery record, and remain visible to admin
  ops. Marking notifications read is deliberately _not_ windowed — "mark all
  as read" sweeps everything, so a notification that ages out of the window
  while still unread doesn't stay unread forever.
- Three delivery strategies exist, chosen per notification type:
  1. **Transactional, email-only** — e.g. the magic-link sign-in email.
     Never cascades to push, never suppressible.
  2. **Money-of-record, fan-out to both** — payment received/failed,
     refunds, lost chargebacks, Wise payment confirmations,
     late-cancellation/no-show notices, subscription billing events. Always
     sent on every eligible channel, never suppressible by a category
     preference. A lost chargeback belongs here for the same reason a
     late-cancellation notice does: it deducts classes the student had already
     paid for, and no preference may silence that.
  3. **Push-first cascade, suppressible** — everything else (class
     reminders, booking updates, materials/homework, package
     expiry/consumption, subscription nudges, in-app chat — see below).
     Push is tried first; email is sent as a fallback only if push isn't
     eligible (no push subscription) or a non-retryable push failure occurs.
- A money-of-record notice states its amount in **the currency actually
  charged**, read off `Payment.currency` (or, for the teacher's own
  subscription, off the Stripe invoice and recorded in the notification's
  metadata at enqueue time). It is never re-derived at send time and never
  falls back to a market default — every one of these notices used to render
  through the MXN default, so a teacher pricing in GBP sent her students
  receipts and refund notices denominated in pesos.
- A **non-retryable** push failure (e.g. every push subscription was rejected)
  falls through to email in the same delivery attempt. A **retryable**
  failure causes the whole dispatch to be retried later rather than
  silently falling back.
- Delivery bookkeeping (which channels were actually attempted/succeeded) is
  tracked per notification so a retried dispatch never sends the same
  notification twice on the same channel.

### Categories and preferences

- Students can toggle these categories: class reminders, booking updates,
  class materials, expiry reminders, and messages (chat).
- Teachers can toggle these categories: class reminders, class activity,
  student progress, subscription, growth, and messages (chat).
- For each category, a user can additionally choose which channel(s)
  (push/email) they want; leaving this unset means "use the default
  push-first cascade" for that category.
- Separately from category preferences, there are global channel opt-outs:
  a user can disable email entirely or push entirely for themselves,
  independent of category.
- **Every suppressible category can be turned off. Money-of-record and
  transactional notifications (payments, refunds, billing, sign-in) can
  never be turned off by any preference** — this is enforced in code, not
  just policy.
- Turning off a category suppresses the notification _before_ it is ever
  attempted on any channel — a suppressed notification is recorded as such,
  not silently dropped without a trace.

### Pre-class reminders

- Both the student and the teacher get a reminder about an upcoming class at
  **24 hours, 1 hour, and 15 minutes** before it starts. Both sides receive the
  same three lead times; the copy differs (the student's names the teacher,
  the teacher's names the student).
- The tightest leg was **5 minutes** until 2026-08-08. It moved to 15 minutes
  for an infrastructure reason, not a product one: a 5-minute leg forces the
  reminder scan to run every 5 minutes, and Neon's scale-to-zero timer is fixed
  at 5 minutes on the Free plan, so the scan alone kept the database awake
  around the clock — roughly 1.8x the plan's monthly compute allowance, which
  suspends the compute outright once spent. The leg was retimed rather than
  dropped so students keep a get-to-your-desk nudge.
- **The 15-minute leg is delivered at exactly `start − 15m`, not rounded to a
  scan tick.** As of D-115 the scan itself runs hourly — the same compute
  arithmetic above applies to every cron, and a quarter-hourly fleet was
  spending ~89 of the 100 free CU-hours a month. Instead of polling faster, each
  scan works out when the next reminder is due and schedules a single wake for
  that precise instant, which re-runs the scan. A class cancelled or rescheduled
  before its wake lands is simply not due when it does, so nothing mis-fires;
  the hourly run is the backstop if a wake is ever lost. Below roughly 5 minutes
  no lead time can be served this way, because consecutive wakes would sit
  closer together than the database's suspend timer.
- **There is no five-days-before reminder.** It used to exist for both
  audiences and was removed at teachers' request — that far out it wasn't
  actionable and read as noise. It is removed, not defaulted off: no
  preference re-enables it, and there is no template behind it any more.
- The five-day mark itself still exists in the reminder scan, but **only to
  release class materials a teacher scheduled for the `t_5d` send timing** —
  that timing is a separate, teacher-chosen feature and is unaffected. A
  student whose teacher scheduled materials at five days out receives the
  materials, and no class reminder alongside them.
- A reminder is never back-fired: a lead time that had already passed when the
  class was booked is skipped rather than sent late. The same rule covers the
  five-day materials release.

### New/not-yet-active students

- A newly added student relationship can be placed on an **onboarding
  hold** — while this hold is active, essentially all lifecycle
  notifications to and about that student are suppressed, regardless of
  category preferences (transactional notifications are still exempt). The
  hold is lifted either when the teacher explicitly marks the student
  "live," or automatically once the student completes their own checkout/
  sign-up.
- Separately, a per-category "everything off" state exists that a teacher
  can apply to one specific student from that student's detail page — this
  produces the same practical effect (no notifications) but through the
  ordinary category-preference mechanism rather than the hold above.
- **Open question**: whether every student created via a bulk/roster import
  automatically starts in this fully-silenced state, or whether that only
  happens via the onboarding-hold mechanism described above — see
  [Open Questions](#open-questions). Do not assume every roster-imported
  student is automatically muted without checking which of these two
  mechanisms actually applied to them.
- An archived teacher-student relationship also suppresses notifications
  (except transactional ones), independent of the above.

### Failed push escalation (safety net)

- A background sweep periodically checks notifications that were sent by
  push but never confirmed delivered.
- If the push genuinely failed (not just "still pending"), and the
  notification hasn't already reached the user by some other channel, the
  system automatically re-attempts delivery by email — subject to the exact
  same preference/hold/archived checks as the original send.
- **Chat message notifications are excluded from this specific safety net**
  — they have their own distinct fallback mechanism, described below,
  because escalating a chat message to email based on push-receipt failure
  alone could re-notify a message the recipient may have already read.
- A push token that comes back permanently invalid during this check is
  retired so it isn't retried indefinitely.

### Device registration

- A browser registers a push subscription once; re-registering the same
  token updates it. A token cannot be silently redirected to a different
  person's account unless it's genuinely the same physical device switching
  between a teacher and student role on it.
- Only one active push destination is kept per physical device at a time —
  registering a new token from a device automatically retires the device's
  other prior tokens, so a shared/handed-off phone doesn't keep notifying
  the previous user.
- Tokens unused for a long time are automatically retired, and each
  recipient is capped at a small number of simultaneously active tokens
  (oldest evicted first).
- A user can also explicitly deregister their device's push token (e.g. on
  sign-out).

## User Flow (step by step)

### Receiving a notification (typical suppressible type, e.g. booking update)

1. A triggering event happens in the product (a booking is created,
   cancelled, materials are sent, etc.).
2. The system checks: is the recipient's relevant category enabled? Are they
   on an onboarding hold or archived? If suppressed, nothing is sent, but the
   suppression is recorded.
3. If not suppressed, the system tries push first, if the recipient has an
   active device and hasn't disabled push for that category/globally.
4. If push succeeds, delivery stops there — no email is sent.
5. If push isn't available or fails outright, email is sent instead
   (subject to the recipient not having disabled email).
6. An in-app inbox entry always reflects this notification; the recipient
   can view/read it any time from within the app, independent of whether
   push or email actually reached them.

### Receiving a notification (money/billing/sign-in type)

1. A triggering event happens (payment received, refund issued, subscription
   payment failed, magic-link requested, etc.).
2. The system attempts every eligible channel unconditionally — this type
   ignores category preferences entirely (they cannot be turned off).

### Managing notification preferences (student)

1. Open account/notification settings.
2. See each category with an on/off toggle and channel choices.
3. Toggle global email/push on or off.
4. See a note that a fixed set of notifications (receipts, sign-in,
   late-cancellation/no-show) always go through regardless of these
   settings.
5. Save.

### Managing notification preferences (teacher)

1. Same as above, with the teacher's own category set.
2. A teacher can additionally open a specific student's page and toggle that
   one student's notifications fully on or off in one action.

### Reaching settings from an email

1. An email footer includes a "manage your notification settings" link.
2. Clicking it deep-links into the app (or prompts sign-in first if
   needed) straight to the correct role's notification settings screen.

## Data Used (business-level entities)

- **Notification** — one record of a single notification instance: who it's
  for, what triggered it, which channel(s) were attempted, its current
  status (queued, sending, sent, delivered, failed, or suppressed), when it
  was read in the in-app inbox (if ever), and any error encountered.
- **Web Push Subscription** — a registered browser push destination for one
  teacher or student, including which app version/device it came from and
  whether it's still active or has been revoked.
- **Notification preferences** — per-teacher and per-student settings
  describing which categories are enabled and which channel(s) are wanted
  for each; plus separate global email/push opt-in flags.
- **Onboarding hold / archived status** — a relationship-level flag that,
  while active, suppresses lifecycle notifications for a given student
  independent of their category preferences.

## Edge Cases

- A recipient with no registered device and email disabled receives nothing
  for a suppressible notification — this is by design, not a bug, since both
  eligible channels were explicitly turned off.
- A push that's accepted by the push service but never confirmed delivered
  is periodically re-checked; if it's confirmed to have failed, the
  fallback-to-email safety net (described above) kicks in for eligible
  notification types.
- A recipient who re-enables a category after a notification was already
  suppressed does not receive that missed notification retroactively — the
  suppression decision is made once, at send time.
- A notification older than 90 days disappears from the recipient's inbox
  and stops counting toward their unread badge, whether or not they ever
  opened it. Paging back through the inbox stops at the window edge rather
  than walking the recipient's whole history. The record itself is not
  deleted — support and `/admin/notifications` can still see it.
- A student on an onboarding hold who completes checkout has the hold
  lifted automatically — any notification-worthy event that happens after
  that point resumes normal delivery.
- A device shared between two people (or one person's teacher and student
  identity on the same phone) only ever gets pushes for the most recently
  registered role/token on that device.

## Error States

- **Suppressed by preference** — recorded distinctly from a delivery
  failure; the recipient chose not to receive this category.
- **Suppressed by onboarding hold / archived relationship** — recorded
  distinctly; not a user preference decision.
- **Push delivery failure** — recorded with the underlying reason; may
  trigger the email fallback depending on notification type and whether the
  failure was retryable.
- **Email delivery failure** — recorded with the underlying reason; for
  fan-out (money/billing) notifications, a push success does not excuse an
  email failure from being visible in the record.
- **No eligible channel at all** (both disabled, or no device and email
  disabled) — the notification cannot be delivered on any channel; this is
  still recorded, not silently discarded.

## Permissions (view / create / edit / delete / approve / cancel by role)

Notifications are exclusively system-generated — there is no user-facing way
to create, edit, or delete an individual notification.

| Action                                                                    | Teacher                      | Student | Other user |
| ------------------------------------------------------------------------- | ---------------------------- | ------- | ---------- |
| View own notification inbox                                               | Yes                          | Yes     | No         |
| Mark own notification read                                                | Yes                          | Yes     | No         |
| Edit own notification preferences (categories, channels, global opt-outs) | Yes                          | Yes     | No         |
| Toggle a specific student's notifications on/off                          | Yes, for their own students  | No      | No         |
| Register/deregister own push subscription                                 | Yes                          | Yes     | No         |
| Trigger a notification directly                                           | No — always system-generated | No      | No         |

## Distinction from chat notifications

In-app chat messages are a **suppressible category** like any other (a user
can turn "messages" notifications off entirely, and doing so blocks the
whole mechanism below before it starts). But when the category is on, the
delivery mechanism for chat is different from every other notification type
in this system:

- A chat message is still tried as **push-first**, same as other
  suppressible categories.
- If push actually succeeds, the system does **not** stop there the way it
  would for other notifications. Instead, it waits a short grace period
  (a few minutes) and then checks whether the message has since been read.
  If it's still unread, it sends an email as a fallback. If the recipient
  already read it (or the specific message was deleted by its sender in the
  meantime), no email is sent.
- This means chat's email fallback is triggered by **whether the recipient
  has actually seen the message**, not by whether the push technically
  failed to deliver — the opposite trigger condition from the general
  failed-push safety net described earlier in this document, which is why
  chat is deliberately excluded from that general safety net.

See `docs/features/messaging-chat.md` for the full messaging feature and the
complete detail of this cascade.

## Open Questions

- **CSV/roster-imported students and "all notifications off"**: existing
  product documentation states that roster-imported students start with
  every notification category off until they opt in, and that this was
  backfilled by an early migration. In the current codebase, the mechanism
  that actually suppresses notifications for a brand-new, not-yet-engaged
  student is the **onboarding hold** (tied to the teacher-student
  relationship, lifted on "go live" or the student's own checkout) — a
  distinct, separate mechanism from the "all categories off" preference
  shape, which today appears to only be reachable through a teacher
  manually flipping a single student's notifications off from that
  student's page, not automatically at student-creation time. Whether every
  current student-creation path (manual add, bulk invite, etc.) still
  produces a fully-silenced student by one of these two mechanisms, and
  which one is the actual source of truth today, should be confirmed before
  treating "CSV-imported = notifications off" as settled fact in
  product-facing communication.
- **Feedback-available-style "should this be suppressible" calls**: some
  suppressible categories (e.g. homework feedback, materials) sit under
  broader categories (class materials, student progress) rather than having
  their own dedicated always-on treatment — confirm this grouping still
  matches product intent rather than being an implementation-convenience
  default.
- **No documented rate limiting** exists for how many notifications a single
  event can generate to a recipient in a short window (aside from the
  cascade/fallback logic itself) — worth confirming this hasn't caused
  complaints in practice.
