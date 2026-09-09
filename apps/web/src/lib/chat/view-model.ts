// Pure view-model helpers for the chat thread.
//
// These live outside the component for two reasons. The first is testability:
// grouping, merging and "am I at the bottom?" are the rules that decide what
// the thread LOOKS like, and they were previously inline in a 1,700-line
// client component where nothing could reach them. The second is the memo —
// `chat-room.tsx` re-renders on every keystroke and every 4-second poll, and
// the merge below is what keeps an unchanged message's object identity stable
// so `MessageBubble`'s `React.memo` actually skips it (see
// tests/components/chat-room-memoization.test.ts for the guard).

import type { ChatMessage } from "@spiralclass/shared";

/**
 * Consecutive messages from the same sender inside this window render as one
 * visual run: a single tail, one timestamp, tight spacing. WhatsApp and
 * iMessage both group; a per-message bubble with its own timestamp turns a
 * three-line thought into three unrelated blocks.
 */
export const CHAT_RUN_GAP_MS = 5 * 60 * 1000;

/**
 * How close to the bottom counts as "following the conversation". Above this,
 * an arriving message must NOT yank the reader down — it raises the
 * jump-to-latest pill instead. 96px is roughly one bubble, so a reader who has
 * scrolled up even slightly is treated as reading history.
 */
export const CHAT_AT_BOTTOM_THRESHOLD_PX = 96;

/** Optimistic messages carry a client id under this prefix until the POST
 * resolves. The prefix is what lets the poll merge below recognise — and
 * retire — a locally-rendered message once the server's own copy arrives. */
export const PENDING_ID_PREFIX = "pending:";

export function isPendingMessage(m: Pick<ChatMessage, "id">): boolean {
  return m.id.startsWith(PENDING_ID_PREFIX);
}

export type ChatRow = {
  message: ChatMessage;
  /** This message opens a new calendar day, so it carries the day divider. */
  startsDay: boolean;
  /** First message of a same-sender run — gets the full outer corner. */
  startsRun: boolean;
  /** Last message of a run — gets the tail corner, the timestamp and the
   * delivery status. Everything above it in the run stays quiet. */
  endsRun: boolean;
};

function isSameLocalDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function joinsRun(earlier: ChatMessage, later: ChatMessage): boolean {
  return (
    earlier.senderRole === later.senderRole &&
    isSameLocalDay(earlier.createdAt, later.createdAt) &&
    Date.parse(later.createdAt) - Date.parse(earlier.createdAt) <= CHAT_RUN_GAP_MS
  );
}

/** Annotate an ascending message list with day and run boundaries. */
export function buildChatRows(messages: ChatMessage[]): ChatRow[] {
  return messages.map((message, i) => {
    const previous = messages[i - 1];
    const next = messages[i + 1];
    return {
      message,
      startsDay: !previous || !isSameLocalDay(previous.createdAt, message.createdAt),
      startsRun: !previous || !joinsRun(previous, message),
      endsRun: !next || !joinsRun(message, next),
    };
  });
}

function sameReactions(a: ChatMessage["reactions"], b: ChatMessage["reactions"]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.role === b[i].role && r.emoji === b[i].emoji);
}

function sameReplyPreview(a: ChatMessage["replyPreview"], b: ChatMessage["replyPreview"]): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.body === b.body && a.senderRole === b.senderRole && a.kind === b.kind;
}

/** Field-for-field equality — the test for "may I keep the old object?". */
function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.id === b.id &&
    a.body === b.body &&
    a.senderRole === b.senderRole &&
    a.createdAt === b.createdAt &&
    a.readAt === b.readAt &&
    a.editedAt === b.editedAt &&
    a.deletedAt === b.deletedAt &&
    a.voiceUrl === b.voiceUrl &&
    a.voiceDurationMs === b.voiceDurationMs &&
    a.videoUrl === b.videoUrl &&
    a.videoDurationMs === b.videoDurationMs &&
    a.imageUrl === b.imageUrl &&
    a.imageWidth === b.imageWidth &&
    a.imageHeight === b.imageHeight &&
    a.fileUrl === b.fileUrl &&
    a.fileName === b.fileName &&
    a.fileSizeBytes === b.fileSizeBytes &&
    a.replyToId === b.replyToId &&
    sameReplyPreview(a.replyPreview, b.replyPreview) &&
    sameReactions(a.reactions, b.reactions)
  );
}

/**
 * Reconcile one polled message against the copy already on screen.
 *
 * The server re-mints a fresh presigned URL on every poll, and a changed `src`
 * makes `<audio>`/`<video>`/`<img>` re-download and restart playback mid-play —
 * so the FIRST URL issued for a message wins for its 24h lifetime. A
 * deleted-for-everyone tombstone is the exception: its media is gone from R2,
 * so it must not resurrect the old URL.
 */
function reconcile(old: ChatMessage, next: ChatMessage): ChatMessage {
  if (next.deletedAt) return sameMessage(old, next) ? old : next;
  const candidate: ChatMessage = {
    ...next,
    voiceUrl: old.voiceUrl ?? next.voiceUrl,
    videoUrl: old.videoUrl ?? next.videoUrl,
    imageUrl: old.imageUrl ?? next.imageUrl,
    fileUrl: old.fileUrl ?? next.fileUrl,
  };
  return sameMessage(old, candidate) ? old : candidate;
}

function byCreatedAt(a: ChatMessage, b: ChatMessage): number {
  const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return delta !== 0 ? delta : a.id.localeCompare(b.id);
}

/**
 * Fold a freshly-polled page into the messages already on screen.
 *
 * `incoming` is only ever the newest page, so anything older that the reader
 * paged in stays put — the previous implementation replaced state outright,
 * which would have silently thrown away loaded history the moment paging
 * existed.
 *
 * Optimistic messages are retired here rather than on the POST's response:
 * a poll can return the server's copy of a just-sent message BEFORE the POST
 * resolves, and without this the thread shows the same sentence twice for up
 * to four seconds. There is no client id echoed back to match on, so the match
 * is sender plus body plus "the server copy is new to us".
 */
export function mergeChatMessages(prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (prev.length === 0) return incoming;

  const known = new Set(prev.map((m) => m.id));
  const arrived = incoming.filter((m) => !known.has(m.id));
  const superseded = new Set<string>();
  for (const pending of prev.filter(isPendingMessage)) {
    const match = arrived.find(
      (m) =>
        !superseded.has(m.id) &&
        m.senderRole === pending.senderRole &&
        m.body === pending.body &&
        m.body !== null,
    );
    if (match) superseded.add(pending.id);
  }

  const merged = new Map<string, ChatMessage>();
  for (const m of prev) {
    if (!superseded.has(m.id)) merged.set(m.id, m);
  }
  for (const next of incoming) {
    const old = merged.get(next.id);
    merged.set(next.id, old ? reconcile(old, next) : next);
  }
  return [...merged.values()].sort(byCreatedAt);
}

/** Splice an older page in ahead of what is already loaded, keeping identity
 * for everything already on screen so nothing below the fold re-renders. */
export function prependChatMessages(prev: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  if (older.length === 0) return prev;
  const known = new Set(prev.map((m) => m.id));
  const fresh = older.filter((m) => !known.has(m.id));
  if (fresh.length === 0) return prev;
  return [...fresh, ...prev].sort(byCreatedAt);
}

/** Is the reader following the live end of the conversation? */
export function isScrolledToBottom(
  el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = CHAT_AT_BOTTOM_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/** Elapsed recording time as m:ss. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/**
 * An attachment's size, in the reader's own locale. The previous version
 * hardcoded a `.` decimal separator, which is a comma across most of the
 * locales this app ships in.
 */
export function formatFileSize(bytes: number | null, locale: string): string {
  if (bytes === null || !Number.isFinite(bytes)) return "";
  const format = (value: number, unit: string, digits: number) =>
    `${new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)} ${unit}`;
  if (bytes < 1024) return format(bytes, "B", 0);
  if (bytes < 1024 * 1024) return format(bytes / 1024, "KB", 0);
  return format(bytes / (1024 * 1024), "MB", 1);
}

/** The server's page size for `GET /api/chat/**`. Mirrored here so the client
 * can tell "a full page came back, there is probably more" from "that was the
 * end of the history". */
export const CHAT_PAGE_SIZE = 50;

let pendingCounter = 0;

/** A client id for an optimistically-rendered message. `crypto.randomUUID` is
 * not present in every environment this component runs in (jsdom included), so
 * uniqueness within the tab is enough — the id never leaves the client. */
export function newPendingId(): string {
  pendingCounter += 1;
  return `${PENDING_ID_PREFIX}${Date.now()}-${pendingCounter}`;
}

/** Swap an optimistic message for the server's own copy, keeping the list
 * ordered and never leaving both on screen. */
export function replacePendingMessage(
  prev: ChatMessage[],
  pendingId: string,
  saved: ChatMessage,
): ChatMessage[] {
  const without = prev.filter((m) => m.id !== pendingId && m.id !== saved.id);
  return [...without, saved].sort(byCreatedAt);
}

/** Drop an optimistic message whose send failed. */
export function dropPendingMessage(prev: ChatMessage[], pendingId: string): ChatMessage[] {
  return prev.filter((m) => m.id !== pendingId);
}

/** How many messages arrived after the last one the reader has seen. */
export function unseenSince(messages: ChatMessage[], lastSeenId: string | null): number {
  if (lastSeenId === null) return 0;
  const index = messages.findIndex((m) => m.id === lastSeenId);
  return index < 0 ? messages.length : messages.length - 1 - index;
}

export type ChatDaySection = { key: string; rows: ChatRow[] };

/**
 * Split annotated rows into one section per calendar day.
 *
 * The day divider is `position: sticky`, and a sticky element only sticks
 * within its own scrolling ancestor's box — so a divider rendered beside its
 * first message unstuck the moment that one message scrolled past, which is
 * every case except a day with exactly one message in it. Wrapping the day's
 * messages in a section is what makes "the day you are reading stays named"
 * true.
 */
export function groupRowsByDay(rows: ChatRow[]): ChatDaySection[] {
  const sections: ChatDaySection[] = [];
  for (const row of rows) {
    if (sections.length === 0 || row.startsDay) sections.push({ key: row.message.id, rows: [row] });
    else sections[sections.length - 1].rows.push(row);
  }
  return sections;
}
