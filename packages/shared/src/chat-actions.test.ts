import { describe, expect, it } from "vitest";

import type { ChatMessage } from "./api";
import {
  CHAT_DELETE_WINDOW_MS,
  CHAT_EDIT_WINDOW_MS,
  QUICK_REACTIONS,
  canDeleteChatMessage,
  canEditChatMessage,
} from "./chat-actions";

const T0 = Date.parse("2026-07-09T12:00:00.000Z");

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    senderRole: "teacher",
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
    createdAt: new Date(T0).toISOString(),
    readAt: null,
    editedAt: null,
    deletedAt: null,
    reactions: [],
    ...over,
  };
}

describe("canEditChatMessage", () => {
  it("allows the sender to edit their own fresh text message", () => {
    expect(canEditChatMessage(msg(), "teacher", T0 + 60_000)).toBe(true);
  });

  it("denies the other party", () => {
    expect(canEditChatMessage(msg(), "student", T0 + 60_000)).toBe(false);
  });

  it("denies once the 15-minute window has passed", () => {
    expect(canEditChatMessage(msg(), "teacher", T0 + CHAT_EDIT_WINDOW_MS + 1)).toBe(false);
    expect(canEditChatMessage(msg(), "teacher", T0 + CHAT_EDIT_WINDOW_MS)).toBe(true);
  });

  it("denies voice and video messages (WhatsApp: media is never editable)", () => {
    expect(canEditChatMessage(msg({ body: null, voiceDurationMs: 3000 }), "teacher", T0)).toBe(
      false,
    );
    expect(canEditChatMessage(msg({ body: null, videoDurationMs: 8000 }), "teacher", T0)).toBe(
      false,
    );
  });

  it("treats a voice note with a null signed URL as still-not-text (R2 misconfig)", () => {
    // voiceUrl null + voiceDurationMs set = voice note whose URL failed to mint.
    expect(
      canEditChatMessage(msg({ body: null, voiceUrl: null, voiceDurationMs: 3000 }), "teacher", T0),
    ).toBe(false);
  });

  it("denies already-deleted messages", () => {
    expect(canEditChatMessage(msg({ deletedAt: new Date(T0).toISOString() }), "teacher", T0)).toBe(
      false,
    );
  });

  it("denies image and file messages (media is never editable)", () => {
    expect(
      canEditChatMessage(msg({ body: null, imageUrl: "https://x/img.jpg" }), "teacher", T0),
    ).toBe(false);
    expect(
      canEditChatMessage(msg({ body: null, fileUrl: "https://x/doc.pdf" }), "teacher", T0),
    ).toBe(false);
  });
});

describe("QUICK_REACTIONS", () => {
  it("has WhatsApp's default six reactions, in order", () => {
    expect(QUICK_REACTIONS).toEqual(["👍", "❤️", "😂", "😮", "😢", "🙏"]);
  });
});

describe("canDeleteChatMessage", () => {
  it("allows the sender to delete any own message type within the window", () => {
    expect(canDeleteChatMessage(msg(), "teacher", T0 + 1000)).toBe(true);
    expect(
      canDeleteChatMessage(msg({ body: null, voiceDurationMs: 3000 }), "teacher", T0 + 1000),
    ).toBe(true);
    expect(
      canDeleteChatMessage(msg({ body: null, videoDurationMs: 8000 }), "teacher", T0 + 1000),
    ).toBe(true);
  });

  it("denies the other party", () => {
    expect(canDeleteChatMessage(msg(), "student", T0 + 1000)).toBe(false);
  });

  it("denies once the delete window has passed", () => {
    expect(canDeleteChatMessage(msg(), "teacher", T0 + CHAT_DELETE_WINDOW_MS + 1)).toBe(false);
    expect(canDeleteChatMessage(msg(), "teacher", T0 + CHAT_DELETE_WINDOW_MS)).toBe(true);
  });

  it("denies an already-deleted message (no double delete)", () => {
    expect(
      canDeleteChatMessage(msg({ deletedAt: new Date(T0).toISOString() }), "teacher", T0),
    ).toBe(false);
  });
});
