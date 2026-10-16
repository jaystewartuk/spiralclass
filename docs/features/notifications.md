# Notifications

Every notification is produced by the product — no user can send one — and
recorded as a `Notification` row that also serves as the in-app inbox entry.
Delivery is by **push** (browser Web Push) and **email** (Resend). Code:
`lib/notifications/` (`enqueue.ts` produces, `dispatcher.ts` delivers,
`preferences.ts` decides what may be silenced), dispatched by the Inngest
function `dispatch-notification`.

## Channels

- Two channels, the `NotificationChannel` enum: `push` and `email`.
- **There is no WhatsApp channel.** The Meta WhatsApp Cloud API integration
  was removed. Kept on purpose: the phone number as a plain contact field
  (`phone_e164` — duplicate detection, roster display, merge) and plain
  `wa.me` links (support, sharing a booking link, a teacher's message-my-student
  button, the booking page's opt-in "Chat on WhatsApp"), which open the
  WhatsApp app and use no Meta integration. If automated WhatsApp messages come
  back, the expected route is a business solution provider that carries Meta's
  verification, not the direct Cloud API.
- **`push` has one transport: Web Push**, to a browser that turned
  notifications on (`lib/notifications/web-push.ts`). `push` stays a single
  enum value with the transport as a detail: per-category channel lists store
  `["push","email"]`, so a new enum member would be missing from every existing
  row and silently excluded.
  - Subscriptions live in `web_push_subscriptions`, keyed by the endpoint URL.
    A 404/410 from the push service soft-revokes one (`revoked_at`); a
    transient failure (429, 5xx, network) never does.
  - Delivery is confirmed synchronously: a Web Push send stamps
    `delivered_at` at dispatch.
  - **Web Push needs a VAPID keypair** (`VAPID_PUBLIC_KEY`,
    `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). With any missing, stored
    subscriptions do not count as push-reachable, so those recipients get
    email. Rotating the public key invalidates every existing subscription.
  - **On iPhone and iPad, Web Push exists only once the site is installed to
    the Home Screen**; the UI says so instead of "your browser doesn't support
    notifications".
- Removing a client retires every feature whose transport it was: when a push
  transport goes, check every sender that used it.

## Delivery strategies

Chosen per template by whether `preferences.ts` gives it a category:

1. **Fan-out, never suppressible by a preference** — templates with no
   category: sign-in (`magic_link`), money-of-record and billing-critical
   notices. Sent on every eligible channel. (An onboarding hold or archived
   pairing still suppresses all but sign-in — see below.)
   - Student money-of-record (`STUDENT_MONEY_OF_RECORD_TEMPLATES`): payment
     received, payment failed, refund, lost chargeback, Wise payment marked
     sent, late cancellation, no-show. A lost chargeback and a late
     cancellation both take classes she paid for; no preference may hide that.
   - Teacher: payment, Wise, Stripe, refund and account-disabled notices, and
     the billing-critical subscription notices (`subscription_payment_failed`,
     `subscription_payment_succeeded`, `subscription_canceled`).
2. **Push-first cascade, suppressible** — everything with a category. Push is
   tried; email is sent only if push is not possible (no subscription, push
   turned off) or fails non-retryably.
3. **Chat** — push-first with a read-aware email three minutes later; see
   [messaging](messaging-chat.md#notifications).

- A **retryable** failure throws so the whole dispatch is retried; a
  non-retryable one moves on to the next channel.
- Channels already sent are recorded (`metadata.channelsSent`), so a retry
  never sends twice on one channel. The dispatcher claims each row
  (`queued` → `sending`) before contacting a provider.
- A money notice states its amount in **the currency actually charged** —
  `Payment.currency`, or for the teacher's own subscription the Stripe invoice,
  recorded in the notification's metadata at enqueue time. It is never
  re-derived at send time and never falls back to a default currency.
- An hourly backstop (`redispatch-queued-cron`) re-emits rows left `queued` because
  their post-commit event was lost.

## Categories and preferences

| Audience | Categories (`packages/shared/src/notifications.ts`)                                           |
| -------- | --------------------------------------------------------------------------------------------- |
| Student  | `class_reminders`, `booking_updates`, `class_materials`, `expiry_reminders`, `messages`       |
| Teacher  | `class_reminders`, `class_activity`, `student_progress`, `subscription`, `growth`, `messages` |

- Each category has an on/off toggle and a channel list (push, email). No
  stored list means every channel.
- Separately, global email and push opt-ins per person.
- A missing key means **on**; a person who never touched settings gets
  everything suppressible.
- **A new student row** (self-checkout, teacher add, invitation) starts with
  `class_reminders`, `booking_updates` and `messages` on, and `class_materials`
  and `expiry_reminders` off (`defaultNewStudentNotificationPrefs`).
- Template-to-category mapping is `templateCategory` (student) and
  `teacherTemplateCategory` (teacher). Homework assigned, feedback, due-soon
  and overdue ride `class_materials`; a homework submission rides the
  teacher's `student_progress`.
- A suppressed notification is recorded with status `suppressed`, not dropped,
  and is never sent later if the category is turned back on.

### New students and the onboarding hold

- A student a teacher adds by hand or invites starts with the pairing on an
  **onboarding hold** (`TeacherStudent.onboardingHoldAt`). While it is set,
  every notification to her from that teacher is suppressed — money notices
  included — except the sign-in email (`isTransactionalTemplate`).
- The hold is lifted when the teacher marks her live (`setStudentLiveAction`),
  when she accepts the invitation, or when she checks out herself.
- Separately, a teacher can switch one student's notifications fully off or
  back on from the student's page (`setStudentNotificationsAsTeacherAction`):
  off writes every category `false`; on clears the preferences back to the
  default (all on).
- An archived pairing suppresses the same way the hold does, with the same
  sign-in exception.

## Pre-class reminders

- Student and teacher each get reminders **24 hours, 1 hour and 15 minutes**
  before a class; the copy names the other person.
- The scan runs **hourly** (`reminder-scan-cron`, [D-115](../decisions/D-115.md)):
  each scan schedules one wake for the exact moment the next reminder is due,
  so the 15-minute leg arrives at `start − 15m`. A class cancelled or moved
  before its wake is simply not due when it fires. Polling faster would keep
  the database's scale-to-zero compute awake.
- No lead time below roughly 5 minutes can be served this way, because wakes
  would sit closer together than the database's suspend timer.
- **There is no five-days-before class reminder**, and no template for one.
  The five-day mark is used only to release materials a teacher scheduled for
  `t_5d` ([library materials](library-materials.md)).
- A lead time that had already passed when the class was booked is skipped,
  never sent late; the same holds for the five-day materials release.

## Inbox

- Every notification is an inbox entry, independent of delivery. `readAt` is
  set only when the recipient opens it there.
- The list and the unread badge show the **last 90 days**
  (`INBOX_RETENTION_DAYS`). Older rows are not deleted; admin still sees them.
  "Mark all as read" is not windowed, so nothing stays unread forever.
- Notices whose email carries a sign-in button show in the inbox without it;
  see [authentication](authentication.md#links-that-sign-a-student-in).
- Every email carries a notification-settings link
  ([authentication](authentication.md#notification-settings-link-does-not-sign-in)).

## Web Push subscriptions

`POST /api/web-push/subscription` registers, `DELETE` revokes
(`app/api/web-push/subscription/route.ts`).

- Re-registering an endpoint refreshes its keys.
- A **live** subscription owned by another recipient cannot be taken over
  (403); a revoked one may be reclaimed (a shared browser after sign-out).
- Each recipient keeps at most **5** live subscriptions, by most recent
  `lastSeenAt`; older ones are revoked.
- Revoking is scoped to the caller's own subscriptions.

## Statuses

`NotificationStatus`: `queued`, `sending`, `sent`, `delivered`, `failed`,
`suppressed`. Suppression (preference, hold, archived pairing) is recorded
separately from failure. A recipient with no push subscription and email
turned off receives nothing for a suppressible notification, by design.

## Permissions

Notifications are system-generated only. Each person can view and mark read
their own inbox, edit their own preferences ([account settings](account-settings.md#notification-preferences))
and register or revoke their own push subscriptions. A teacher can switch one
of her own students' notifications on or off. Admins see delivery health,
retry failed sends and send broadcasts ([admin portal](admin-portal.md#operations)).

## Open questions

- Homework feedback and materials share `class_materials` rather than having
  their own categories; confirm that grouping is what students want.
- Nothing limits how many notifications one event or burst sends to a
  recipient beyond the cascade itself.
