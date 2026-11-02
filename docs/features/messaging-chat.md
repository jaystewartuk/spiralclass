# Messaging / Chat

Teachers and students message each other in a private one-to-one thread —
text, voice notes, short videos, images and files. A thread is every message
between one teacher and one student; there is no conversation record and no
group chat.

Chat refreshes by polling while it is open, not by a realtime database
feature, so the data stays portable ([D-70](../decisions/D-70.md)). Its
notifications go push first and email only if the message is still unread
three minutes later ([below](#notifications)).

Routes: `app/api/chat/{teacher,student}/…` (thread, text, `voice`, `video`,
`image`, `file`, `[messageId]`, `reactions`, `threads`). Shared rules:
`packages/shared/src/chat-actions.ts`, `lib/chat/`.

## Business rules

### Thread scope

- A thread is the (teacher, student) pair.
- Every read and send checks that a `TeacherStudent` link exists between the
  two (for a student, across every row sharing her email); otherwise the
  response is **not found**.
- The "new conversation" picker offers only non-archived pairings. The send
  routes check that the link exists, **not** that it is unarchived, so an
  archived pairing's existing thread still accepts messages.
- There is no blocking and no rate limit on sending.

### Sending

- Text ≤ 4,000 characters, both directions.
- A message can carry text, an attachment, or both, and may reply to another
  message in the **same** thread (`validateReplyToId`, `lib/chat/reply.ts`).

### Attachments

| Kind       | Max    | Types                                                          |
| ---------- | ------ | -------------------------------------------------------------- |
| Voice note | 10 MB  | the audio set in `lib/storage/chat-audio.ts`                   |
| Video clip | 100 MB | `lib/storage/chat-video.ts`                                    |
| Image      | 10 MB  | `lib/storage/chat-image.ts`                                    |
| File       | 25 MB  | PDF, Word, Excel, PowerPoint, plain text, zip — no executables |

Uploads go straight to storage, then the server confirms them, re-checking that
the object exists, its real size, and that it is under the sender's own key.
Nothing the client claims is trusted.

### Editing

- Sender only, **plain text only** (a message with any attachment cannot be
  edited), within **15 minutes** (`CHAT_EDIT_WINDOW_MS`).
- Saving identical text does not mark it edited. An edited message is marked
  for both people.

### Deleting ("delete for everyone")

- Sender only, any message type, within **60 hours** (`CHAT_DELETE_WINDOW_MS`).
- Leaves a "message deleted" placeholder; text and media are cleared for good.
  Deleting again is a no-op.

### Reactions

- Either participant can react to any non-deleted message, their own included,
  with no time limit.
- One reaction per person per message: the same emoji again removes it, a
  different one replaces it.
- The emoji is validated by length (1–8 characters) only.

### Read state and polling

- Fetching a thread marks every unread message from the other person as read;
  there is no separate mark-as-read action.
- An open thread polls about every 4 seconds while the tab is visible
  (`useVisibilityPolling`), pauses when hidden, and refreshes at once on
  return. A new message can take a few seconds to appear.

## Notifications

`chat_message` (to a student, category `messages`) and `chat_message_teacher`
(to a teacher, category `messages`). Turning the category off stops all of
the below.

1. The message is pushed first, like any suppressible notification.
2. **If the push is sent**, the dispatcher waits **3 minutes**
   (`CHAT_EMAIL_FALLBACK_GRACE`, `lib/inngest/functions/dispatch-notification.ts`)
   and emails only if the thread still has unread messages from that sender —
   and not if the triggering message was deleted meanwhile.
3. **If push is not possible** (no subscription, or push off), email goes at
   once.

The trigger is whether the recipient has **read** the message, not whether a
push was delivered, so a message she saw on her phone is never emailed. The
general cascade is in [notifications](notifications.md#delivery-strategies).

## Error states

- No link between the two → not found.
- Edit after 15 minutes, delete after 60 hours, or editing a message with an
  attachment → rejected.
- Editing or deleting someone else's message → rejected.
- Attachment too large, wrong type, or not under the sender's key → rejected.

## Permissions

| Action                                | Sender | Other participant | Anyone else |
| ------------------------------------- | ------ | ----------------- | ----------- |
| View thread, send, react              | Yes    | Yes               | No          |
| Edit (text only, within 15 min)       | Yes    | No                | No          |
| Delete (within 60 h)                  | Yes    | No                | No          |
| Start a thread (non-archived pairing) | Yes    | Yes               | No          |

## Open questions

- Should sending to an archived pairing be refused?
- No blocking and no rate limiting exist; confirm both are acceptable.
