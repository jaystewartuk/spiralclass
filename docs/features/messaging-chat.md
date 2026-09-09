# Messaging / Chat

## Overview

Teachers and students can message each other directly inside the app —
text, voice notes, short videos, images, and file attachments — in a private
one-to-one thread scoped to that specific teacher-student relationship.
There is no group chat and no separate "conversation" object to create: a
thread is simply every message ever exchanged between one teacher and one
student.

The chat is deliberately **not** built on a realtime push infrastructure
(e.g. WebSockets/Realtime) — it works by the app periodically checking for
new messages while it's open and in the foreground ("polling"), which keeps
the underlying data fully portable and independent of any single database
vendor's realtime features.

Chat has its own distinctive notification behavior that is different from
every other notification type in the product: a message tries push first,
and only follows up with an email a few minutes later, and only if the
recipient still hasn't read it by then. See
[Chat notification pipeline](#chat-notification-pipeline) below.

## User Stories

- As a student, I want to message my teacher a question outside of class
  time.
- As a teacher, I want to message a student about scheduling, homework, or
  general check-ins.
- As either party, I want to send a voice note, a photo, a short video, or a
  document, not just text.
- As either party, I want to react to a message with an emoji without
  sending a separate reply.
- As either party, I want to fix a typo shortly after sending a text
  message.
- As either party, I want to delete something I sent by mistake.
- As either party, I want to know if my message has been read.
- As either party, I want to be notified of a new message even if I'm not
  looking at the app, but not get a duplicate/unnecessary email if I've
  already read it on my phone.

## Business Rules (exhaustive)

### Thread scope and access

- A thread is uniquely identified by the (teacher, student) pair — there is
  no separate conversation/thread record.
- A student may only message a teacher they have an actual enrollment
  relationship with (a `TeacherStudent` link must exist). A teacher may only
  message a student they have that same relationship with.
- The "start a new conversation" picker only offers teachers/students whose
  relationship isn't archived, as available recipients to start a new
  thread with.

### Sending

- A text message body is limited to 4,000 characters (both directions).
- Attachments (see below) can be sent instead of, or alongside, text.
- There is no message rate limit and no blocking mechanism between a teacher
  and student today — either party can always message the other as long as
  the underlying relationship exists.

### Editing

- Only the **sender** of a message can edit it.
- Only a **plain text** message can be edited — a message that has voice,
  video, image, or file content attached to it cannot be edited.
- Editing is only allowed within **15 minutes** of when the message was
  originally sent.
- Editing to the exact same text is accepted silently without marking the
  message as edited.
- An edited message is visibly marked as edited to both participants.

### Deleting ("delete for everyone")

- Only the **sender** of a message can delete it.
- Any message type (text, voice, video, image, file) can be deleted.
- Deleting is only allowed within roughly **2.5 days** of when the message
  was sent.
- Deleting does not remove the message from the thread history entirely — it
  leaves a visible "this message was deleted" placeholder, with the actual
  content (text and any attached media) permanently cleared.
- Deleting is safe to repeat — deleting an already-deleted message just
  confirms it's deleted rather than erroring.

### Reactions

- Either participant (not just the message's recipient) can react to any
  message that hasn't been deleted — reactions are not restricted to the
  message's recipient.
- Each person may have **at most one reaction per message** — reacting again
  with the same emoji removes the reaction; reacting with a different emoji
  replaces the previous one.
- There is no time limit on reacting (unlike editing/deleting a message).

### Attachments

Four kinds of attachments are supported, each with its own size limit:

- **Voice note** — up to 10 MB.
- **Video clip** (short, selfie-style) — up to 100 MB.
- **Image** — up to 10 MB.
- **File/document** — up to 25 MB, restricted to common document types
  (PDF, Word, Excel, PowerPoint, plain text, zip) — no executable or script
  file types are ever accepted.
- All attachments are uploaded directly to storage and then confirmed by the
  app server, which independently re-validates the file actually exists,
  its real size, and that it belongs to the authenticated sender — none of
  this trusts what the client claims.

### Read state and polling

- Opening/refreshing a thread is what marks the counterpart's messages as
  read — there is no separate "mark as read" action; simply fetching the
  thread's messages (which the app does automatically while open) stamps
  read state on any of the other person's unread messages in that thread.
  One visit to the thread clears the unread state for every message from
  that sender at once.
- The app checks for new messages automatically roughly every 4 seconds
  while a thread screen (or, on web, the browser tab) is open and active; it
  pauses this checking when the tab/app is backgrounded and does an
  immediate refresh the moment it's foregrounded again.
- This is a deliberate design choice to keep chat data portable (not tied to
  a specific realtime database feature) at the cost of true instant
  delivery — a message can take up to a few seconds to visibly appear for
  the other person if they already have the thread open.

## User Flow (step by step)

### Starting or continuing a conversation

1. Open the Messages section.
2. See a list of existing threads, each showing the last message and unread
   count, or start a new thread by picking an eligible (non-archived)
   teacher/student.
3. Open a thread to see the full message history, refreshing automatically.

### Sending a message

1. Type text and/or attach a voice note, video, image, or file.
2. Send. The message appears immediately in your own view; the other
   participant sees it the next time their app polls (within a few seconds
   if their thread is open).

### Editing a message

1. Within 15 minutes of sending a text-only message, select edit.
2. Change the text and save — the message now shows an "edited" indicator to
   both participants.
3. After 15 minutes, or for any message with an attachment, editing is no
   longer available.

### Deleting a message

1. Within about 2.5 days of sending, select delete, confirm.
2. The message's content (text and/or media) is cleared and replaced with a
   "deleted" placeholder visible to both participants; the delete cannot be
   undone.

### Reacting to a message

1. Long-press/select a message (either your own or the other person's), pick
   an emoji from a quick-reaction row or a full picker.
2. The reaction appears attached to that message.
3. Tapping the same emoji again removes it; picking a different emoji
   replaces it.

### Reading and notification

1. A new message triggers a push notification to the recipient (if their
   "messages" notification category is enabled).
2. If the recipient opens the thread, their read state updates and no
   further notification follows for that message.
3. If the recipient does not open the thread within a few minutes, they
   also receive an email about the unread message (see below).

## Data Used (business-level entities)

- **Message** — one item in a thread: which teacher/student pair it belongs
  to, who sent it (teacher or student), its text and/or attached voice/
  video/image/file content, when it was sent, when it was read, when it was
  last edited (if ever), and when it was deleted (if ever, as a tombstone
  rather than a hard delete).
- **Message Reaction** — one emoji reaction from one participant on one
  message; at most one per (message, participant) pair.
- **Notification preference (messages category)** — whether a teacher or
  student wants to receive notifications for this thread type at all (see
  `docs/features/notifications.md`).

## Edge Cases

- A message with only an attachment (no text) can still be deleted but never
  edited — editing is text-only regardless of whether text is also present.
- Reacting to a message doesn't require having read the whole thread first,
  and isn't limited to the message's recipient — the sender can react to
  their own message, or to any message in the thread.
- If a message is deleted while an email fallback for it is still pending
  (see below), the pending email fallback is skipped even if other messages
  in the thread remain unread — it will not resurrect a retracted message's
  preview in an email.
- Editing a message that already had a pending or already-sent email
  notification updates the preview text those reflect, where technically
  possible.
- A single visit to a thread clears unread state for every message from
  that sender at once — a recipient can't "partially" read a thread and
  leave some messages marked unread while others are read.

## Error States

- **Not an enrolled relationship** — a student attempting to message a
  teacher they have no relationship with (or vice versa) is rejected as if
  the recipient doesn't exist.
- **Edit window expired** — editing after 15 minutes is rejected.
- **Delete window expired** — deleting after ~2.5 days is rejected.
- **Editing a non-text message** — rejected regardless of timing.
- **Editing/deleting someone else's message** — rejected; only the original
  sender may edit or delete their own message.
- **Attachment too large or wrong type** — rejected before or during upload.
- **Attachment path/ownership mismatch** — rejected server-side even if a
  client attempts to reference someone else's storage object.

## Permissions (view / create / edit / delete / approve / cancel by role)

| Action                                  | Message sender                                       | Other thread participant | Unrelated user |
| --------------------------------------- | ---------------------------------------------------- | ------------------------ | -------------- |
| View thread                             | Yes                                                  | Yes                      | No             |
| Send message                            | Yes (either party, subject to relationship existing) | Yes                      | No             |
| Edit message (text-only, within 15 min) | Yes                                                  | No                       | No             |
| Delete message (within ~2.5 days)       | Yes                                                  | No                       | No             |
| React to any non-deleted message        | Yes                                                  | Yes                      | No             |
| Start new thread                        | Yes, with a non-archived counterpart                 | Yes                      | No             |

There is no "approve" or "cancel" concept in chat — every send/edit/delete/
react action is immediate and unilateral by the acting party, subject only
to the ownership/timing rules above.

## Chat notification pipeline

Chat uses a distinctive delivery pattern that differs from the rest of the
notification system (full general system documented in
`docs/features/notifications.md`):

1. A new message is first attempted via **push**, exactly like other
   suppressible notification categories.
2. **If push succeeds**, the system does not stop there the way it would for
   any other notification type. Instead, it waits a short grace period
   (**3 minutes**) and then re-checks: is the message (or any other message
   from that same sender in the thread) still unread?
   - If it's still unread, an email is now sent as a follow-up.
   - If the recipient has since read it, no email is sent at all.
   - If the specific triggering message was deleted by its sender in the
     meantime, no email is sent for it, even if other unread messages exist
     in the thread.
3. **If push fails immediately** (e.g. no registered device), email is sent
   right away instead — there is no 3-minute wait in that case, since
   there's nothing to wait and see about.
4. Chat is deliberately **excluded** from the general "failed push receipt
   escalates to email" safety net used by every other notification type
   (described in `docs/features/notifications.md`) — that general mechanism
   triggers off of push _delivery failure_, while chat's own mechanism
   triggers off of the recipient's _read state_, a meaningfully different
   condition. Applying the general mechanism to chat could re-notify by
   email a message the recipient had, in fact, already seen on their phone.
5. All of this is still gated by the recipient's own "messages" category
   preference — if a user has turned off messages notifications entirely,
   none of the above happens at all; the 3-minute read-aware mechanism only
   governs _how_ an enabled notification is delivered, not whether the
   category can be muted.

## Open Questions

- **Archived-relationship enforcement on sending, not just discovery**: the
  "start a new conversation" recipient picker excludes archived
  relationships, but it's not fully confirmed that the message-send
  endpoint itself re-checks archived status for an existing thread (as
  opposed to only checking that the relationship ever existed) — worth a
  dedicated test if this matters for a teacher who has archived a student
  but an old conversation link/bookmark still exists.
- **No blocking feature** — a teacher or student cannot block the other
  from messaging them. Confirm whether this is intentional or a planned
  gap, especially for any future trust & safety need.
- **No message rate limiting** exists today. Confirm this is acceptable at
  current scale.
- **Emoji reaction validation** is a length check, not true validation that
  the input is actually a single emoji — a short non-emoji string could
  theoretically be stored as a "reaction." Low real-world risk, but worth
  knowing if reaction data is ever used for analytics.
- **Very old notification records** (from before message-linked metadata was
  added) may not carry enough detail to be retroactively matched to a
  specific message — not relevant to current behavior, but worth knowing
  when auditing historical notification data.
