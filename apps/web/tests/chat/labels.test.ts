import { describe, expect, it } from "vitest";
import { createT, type ChatMessage } from "@spiralclass/shared";
import {
  chatMessageKind,
  dayDividerLabel,
  emojiCategoryLabel,
  formatMessageDateTime,
  formatMessageTime,
  isEmojiOnly,
  isTextMessage,
  mediaPlaceholder,
  messageToClipboardText,
  replyPreviewText,
} from "@/lib/chat/labels";

const t = createT("en");

function msg(extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    senderRole: "student",
    body: "hola",
    replyToId: null,
    replyPreview: null,
    voiceUrl: null,
    voiceDurationMs: null,
    videoUrl: null,
    videoDurationMs: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    fileUrl: null,
    fileName: null,
    fileSizeBytes: null,
    fileMimeType: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    readAt: null,
    editedAt: null,
    deletedAt: null,
    reactions: [],
    ...extra,
  };
}

describe("chatMessageKind", () => {
  it("names every kind", () => {
    expect(chatMessageKind(msg())).toBe("text");
    expect(chatMessageKind(msg({ body: null, voiceDurationMs: 1000 }))).toBe("voice");
    expect(chatMessageKind(msg({ body: null, videoDurationMs: 1000 }))).toBe("video");
    expect(chatMessageKind(msg({ body: null, imageUrl: "https://r2/i" }))).toBe("image");
    expect(chatMessageKind(msg({ body: null, fileUrl: "https://r2/f" }))).toBe("file");
  });

  it("still reads as a voice note when R2 could not sign a URL", () => {
    // The duration is the durable fact; the signed URL is not. Keying off the
    // URL alone made a voice note look editable whenever signing failed.
    expect(chatMessageKind(msg({ body: null, voiceUrl: null, voiceDurationMs: 2000 }))).toBe(
      "voice",
    );
    expect(isTextMessage(msg({ body: "x", voiceDurationMs: 2000 }))).toBe(false);
  });
});

describe("messageToClipboardText", () => {
  it("copies the body of a text message", () => {
    expect(messageToClipboardText(msg({ body: "buenas" }), t)).toBe("buenas");
  });

  it("copies a bracketed stand-in for anything that is not text", () => {
    expect(messageToClipboardText(msg({ body: null, imageUrl: "https://r2/i" }), t)).toBe(
      t("chat.selection.placeholderImage"),
    );
    expect(messageToClipboardText(msg({ body: null, fileUrl: "https://r2/f" }), t)).toBe(
      t("chat.selection.placeholderFile"),
    );
  });

  it("copies the tombstone for a deleted message, whatever it used to be", () => {
    expect(
      messageToClipboardText(msg({ body: null, deletedAt: "2026-09-01T11:00:00.000Z" }), t),
    ).toBe(t("chat.selection.placeholderDeleted"));
  });
});

describe("replyPreviewText", () => {
  it("is empty when the message is not a reply", () => {
    expect(replyPreviewText(null, t)).toBe("");
  });

  it("quotes the original body", () => {
    expect(
      replyPreviewText({ id: "m0", body: "pregunta", senderRole: "teacher", kind: "text" }, t),
    ).toBe("pregunta");
  });

  it("uses the same placeholder the clipboard does for media", () => {
    expect(
      replyPreviewText({ id: "m0", body: null, senderRole: "teacher", kind: "voice" }, t),
    ).toBe(mediaPlaceholder("voice", t));
  });

  it("marks a quote whose original was deleted", () => {
    expect(replyPreviewText({ id: "m0", body: null, senderRole: "teacher", kind: "text" }, t)).toBe(
      t("chat.selection.placeholderDeleted"),
    );
  });
});

describe("formatMessageTime", () => {
  it("follows the APP's locale, not the operating system's", () => {
    const iso = new Date(2026, 8, 1, 15, 30).toISOString();
    // en-US style is 12-hour; French is 24-hour. One thread must not mix a
    // localized day divider with a system-localized clock.
    expect(formatMessageTime(iso, "en")).toMatch(/PM/i);
    expect(formatMessageTime(iso, "fr")).toMatch(/15/);
  });
});

describe("dayDividerLabel", () => {
  it("names today and yesterday in words", () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(dayDividerLabel(now.toISOString(), t, "en")).toBe(t("chat.day.today"));
    expect(dayDividerLabel(yesterday.toISOString(), t, "en")).toBe(t("chat.day.yesterday"));
  });

  it("writes the date out for anything older, adding the year only across one", () => {
    const thisYear = new Date(new Date().getFullYear(), 0, 15);
    expect(dayDividerLabel(thisYear.toISOString(), t, "en")).toBe("January 15");
    const longAgo = new Date(2021, 4, 3);
    expect(dayDividerLabel(longAgo.toISOString(), t, "en")).toContain("2021");
  });
});

describe("emojiCategoryLabel", () => {
  it("translates a known category and passes an unknown one through", () => {
    expect(emojiCategoryLabel(t, "hearts")).toBe(t("chat.emoji.categories.hearts"));
    expect(emojiCategoryLabel(t, "sports")).toBe("sports");
  });
});

describe("isEmojiOnly", () => {
  it("accepts a short run of emoji, which is what gets drawn bubbleless", () => {
    expect(isEmojiOnly("😴")).toBe(true);
    expect(isEmojiOnly("✌️")).toBe(true);
    expect(isEmojiOnly("🎉🎉")).toBe(true);
    // Whitespace between them is still a gesture, not a sentence.
    expect(isEmojiOnly(" 👍 👍 ")).toBe(true);
  });

  it("accepts a skin-tone modifier, a ZWJ sequence and a flag as ONE glyph each", () => {
    expect(isEmojiOnly("👍🏽")).toBe(true);
    expect(isEmojiOnly("👩‍💻")).toBe(true);
    expect(isEmojiOnly("🇲🇽")).toBe(true);
    expect(isEmojiOnly("👩‍💻👩‍💻👩‍💻")).toBe(true);
  });

  it("rejects text, and text mixed with emoji", () => {
    expect(isEmojiOnly("hola")).toBe(false);
    expect(isEmojiOnly("😀 hola")).toBe(false);
    expect(isEmojiOnly("ok 👍")).toBe(false);
  });

  it("rejects digits and letters, which carry Emoji_Component", () => {
    expect(isEmojiOnly("123")).toBe(false);
    expect(isEmojiOnly("OK")).toBe(false);
    expect(isEmojiOnly("#")).toBe(false);
  });

  it("rejects a wall of emoji — past a handful it is a message again", () => {
    expect(isEmojiOnly("😀😀😀😀")).toBe(false);
  });

  it("rejects nothing at all", () => {
    expect(isEmojiOnly("")).toBe(false);
    expect(isEmojiOnly("   ")).toBe(false);
    expect(isEmojiOnly(null)).toBe(false);
    expect(isEmojiOnly(undefined)).toBe(false);
  });
});

describe("formatMessageDateTime", () => {
  it("names the day as well as the time, which the visible label cannot", () => {
    const full = formatMessageDateTime("2026-09-01T10:00:00.000Z", "en");
    expect(full).toContain("2026");
    expect(full).toMatch(/September/);
  });
});
