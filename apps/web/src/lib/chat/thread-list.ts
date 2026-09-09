// Pure copy/format derivation for the conversation list — the inbox rail on a
// wide window and the full-width list on a phone are the same rows, so the
// preview line, the search match and the timestamp are decided in one place
// rather than once per surface.

import type { AppLocale, ChatMessageKind, ChatThread, TFunction } from "@spiralclass/shared";
import { timeOptionsFor } from "@spiralclass/shared";
import { toYMD } from "@/lib/tz";

/** The subset of a thread summary the shared row helpers read. */
export type ThreadSummary = Pick<ChatThread, "lastMessage" | "lastMessageKind">;

/**
 * The one-line preview under a name.
 *
 * A deleted message is named as deleted, an attachment by its kind, and text
 * by its first line — a pasted multi-line message otherwise put its second
 * line's leading whitespace into a row that only ever shows one line.
 */
export function threadPreviewText(thread: ThreadSummary, t: TFunction): string {
  const last = thread.lastMessage;
  if (!last) return "";
  if (last.deletedAt) {
    return last.senderRole === "teacher"
      ? t("web.messages.youDeletedThisMessage")
      : t("web.messages.thisMessageWasDeleted");
  }
  const kind = thread.lastMessageKind ?? "text";
  if (kind !== "text") return last.fileName ?? attachmentPreview(kind, t);
  const body = last.body ?? "";
  const firstLine = body.split("\n", 1)[0]?.trim() ?? "";
  return firstLine;
}

/**
 * An attachment named for a list row.
 *
 * Deliberately NOT `mediaPlaceholder` from ./labels: that one is bracketed
 * ("[photo]") because it stands in for content inside a copied transcript or a
 * quoted reply, where the brackets say "this is not what they typed". A list
 * row is a caption, not a transcript, so it reads as a noun.
 */
function attachmentPreview(kind: ChatMessageKind, t: TFunction): string {
  switch (kind) {
    case "voice":
      return t("chat.preview.voice");
    case "video":
      return t("chat.preview.video");
    case "image":
      return t("chat.preview.image");
    case "file":
      return t("chat.preview.file");
    default:
      return "";
  }
}

/**
 * Name search, accent- and case-insensitive: a teacher typing "jose" must find
 * "José". `localeCompare` cannot express "contains", so the fold is explicit —
 * NFD splits an accented character into its base letter plus its mark, and the
 * mark range is then dropped.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

export function filterThreadsByName<T extends { studentName: string }>(
  threads: T[],
  query: string,
): T[] {
  const q = foldForSearch(query.trim());
  if (!q) return threads;
  return threads.filter((thread) => foldForSearch(thread.studentName).includes(q));
}

/**
 * A thread's timestamp: the time if it happened today, "Yesterday" if it
 * happened yesterday, the weekday inside the last week, and a date beyond
 * that — the resolution a reader can actually use at a glance, rather than
 * "5 Sep" for both this morning and last March.
 *
 * `tz` is the VIEWER's zone, and it is a parameter rather than the runtime's
 * own because this also runs on the server: without it a message sent near the
 * teacher's local midnight would flip between "today" and "yesterday" purely
 * on the server process's UTC day boundary. Same reason booking-day-groups.ts
 * takes one.
 */
export function formatThreadTimestamp(
  iso: string,
  locale: AppLocale,
  tz: string,
  t: TFunction,
  now: Date = new Date(),
): string {
  const at = new Date(iso);
  const days = daysApartInZone(at, now, tz);
  if (days === 0) return at.toLocaleTimeString(locale, { ...timeOptionsFor(locale), timeZone: tz });
  if (days === 1) return t("chat.day.yesterday");
  if (days < 7) return at.toLocaleDateString(locale, { weekday: "short", timeZone: tz });
  return at.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: sameYearInZone(at, now, tz) ? undefined : "numeric",
    timeZone: tz,
  });
}

/** Whole days between two instants, counted by calendar day in `tz`. */
function daysApartInZone(a: Date, b: Date, tz: string): number {
  const dayA = Date.parse(`${toYMD(a, tz)}T00:00:00Z`);
  const dayB = Date.parse(`${toYMD(b, tz)}T00:00:00Z`);
  return Math.round((dayB - dayA) / 86_400_000);
}

function sameYearInZone(a: Date, b: Date, tz: string): boolean {
  return toYMD(a, tz).slice(0, 4) === toYMD(b, tz).slice(0, 4);
}
