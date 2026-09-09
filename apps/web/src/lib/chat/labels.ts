// Copy derivation for the chat thread: the one place a message kind is turned
// into words. Split out of the component so the placeholder used by the
// clipboard, the reply quote and the notification preview cannot drift apart —
// they were three separate switch statements over the same five kinds.

import type { AppLocale, ChatMessage, ChatMessageKind, TFunction } from "@spiralclass/shared";
import { timeOptionsFor } from "@spiralclass/shared";

export type { ChatMessageKind } from "@spiralclass/shared";

/**
 * Text-ness is derived from the duration/attachment fields rather than the
 * signed URLs, matching `canEditChatMessage` in the shared package: a signed
 * URL comes back null when R2 is misconfigured, and that must not make a voice
 * note look like a text message.
 */
export function isTextMessage(m: ChatMessage): boolean {
  return (
    m.body !== null &&
    m.voiceDurationMs === null &&
    m.videoDurationMs === null &&
    m.imageUrl === null &&
    m.fileUrl === null
  );
}

export function chatMessageKind(m: ChatMessage): ChatMessageKind {
  if (m.voiceUrl || m.voiceDurationMs !== null) return "voice";
  if (m.videoUrl || m.videoDurationMs !== null) return "video";
  if (m.imageUrl) return "image";
  if (m.fileUrl) return "file";
  return "text";
}

/** The bracketed stand-in a non-text message gets wherever plain text is
 * required — clipboard, quoted reply, thread-list preview. */
export function mediaPlaceholder(kind: ChatMessageKind, t: TFunction): string {
  switch (kind) {
    case "voice":
      return t("chat.selection.placeholderVoice");
    case "video":
      return t("chat.selection.placeholderVideo");
    case "image":
      return t("chat.selection.placeholderImage");
    case "file":
      return t("chat.selection.placeholderFile");
    default:
      return "";
  }
}

export function messageToClipboardText(m: ChatMessage, t: TFunction): string {
  if (m.deletedAt) return t("chat.selection.placeholderDeleted");
  if (isTextMessage(m)) return m.body ?? "";
  return mediaPlaceholder(chatMessageKind(m), t) || (m.body ?? "");
}

export function replyPreviewText(preview: ChatMessage["replyPreview"], t: TFunction): string {
  if (!preview) return "";
  if (preview.kind !== "text") return mediaPlaceholder(preview.kind, t);
  return preview.body ?? t("chat.selection.placeholderDeleted");
}

export function emojiCategoryLabel(t: TFunction, key: string): string {
  switch (key) {
    case "smileys":
      return t("chat.emoji.categories.smileys");
    case "gestures":
      return t("chat.emoji.categories.gestures");
    case "hearts":
      return t("chat.emoji.categories.hearts");
    case "animals":
      return t("chat.emoji.categories.animals");
    case "food":
      return t("chat.emoji.categories.food");
    case "objects":
      return t("chat.emoji.categories.objects");
    default:
      return key;
  }
}

/**
 * A message's wall-clock time, in the APP's resolved locale.
 *
 * It used to resolve against `new Intl.DateTimeFormat().resolvedOptions()` —
 * the browser's own locale — on the stated grounds that the component "has
 * never been handed the app's resolved locale". That stopped being true when
 * the day dividers started taking a `locale` prop, and the result was one
 * thread rendering "Yesterday" in the app's language directly above a
 * timestamp in the operating system's. One locale decides both.
 */
export function formatMessageTime(iso: string, locale: AppLocale): string {
  return new Date(iso).toLocaleTimeString(locale, timeOptionsFor(locale));
}

/** "Today" / "Yesterday" / a written date, for the sticky day divider. */
export function dayDividerLabel(iso: string, t: TFunction, locale: AppLocale): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return t("chat.day.today");
  if (diffDays === 1) return t("chat.day.yesterday");
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/**
 * At most this many emoji still read as a gesture rather than as a message.
 * Beyond it the enlarged glyphs stop being a reaction and start being a wall.
 */
const MAX_JUMBO_EMOJI = 3;

/**
 * Does this body consist of nothing but a few emoji?
 *
 * Every messaging product people already use draws that case big and without a
 * bubble, because a thumbs-up is a gesture, not a sentence — and a 17px emoji
 * inside a full bubble reads as a rendering accident. This is the predicate
 * for it.
 *
 * `Emoji_Component` is deliberately NOT accepted: digits and the keycap and
 * regional-indicator letters all carry it, so accepting it would enlarge "123"
 * and "OK". A whole flag (two regional indicators) and a skin-tone modifier
 * are accepted explicitly instead.
 */
export function isEmojiOnly(body: string | null | undefined): boolean {
  const text = (body ?? "").trim();
  if (!text) return false;
  if (
    !/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\uFE0F\u200D]|\s)+$/u.test(
      text,
    )
  ) {
    return false;
  }
  return countGraphemes(text) <= MAX_JUMBO_EMOJI;
}

/**
 * Grapheme clusters, so a ZWJ sequence (👩‍💻, one glyph made of two
 * pictographs and a joiner) counts as the one thing a reader sees. Falls back
 * to counting pictographs where `Intl.Segmenter` is missing — that
 * over-counts a joined family emoji, which errs toward the normal bubble
 * rather than toward an enormous one.
 */
function countGraphemes(text: string): number {
  const stripped = text.replace(/\s+/gu, "");
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(stripped)].length;
  }
  return [...stripped.matchAll(/\p{Extended_Pictographic}/gu)].length;
}

/**
 * The full date and time behind a message's timestamp, for the `title` a
 * pointer reveals: the row itself shows only a wall-clock time, and "10:36"
 * six screens up a thread does not say which day.
 */
export function formatMessageDateTime(iso: string, locale: AppLocale): string {
  return new Date(iso).toLocaleString(locale, {
    dateStyle: "long",
    timeStyle: "short",
  });
}
