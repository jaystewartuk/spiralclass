import { describe, expect, it } from "vitest";
import { createT, type ChatMessage, type ChatThread } from "@spiralclass/shared";
import {
  filterThreadsByName,
  foldForSearch,
  formatThreadTimestamp,
  threadPreviewText,
} from "@/lib/chat/thread-list";

const t = createT("en");

function lastMessage(extra: Partial<ChatMessage> = {}): ChatMessage {
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
    createdAt: "2026-09-05T10:00:00.000Z",
    readAt: null,
    editedAt: null,
    deletedAt: null,
    reactions: [],
    ...extra,
  };
}

function thread(extra: Partial<ChatThread> = {}): ChatThread {
  return {
    studentId: "s1",
    studentName: "Marta Ibarra",
    lastMessage: lastMessage(),
    lastMessageKind: "text",
    unreadCount: 0,
    ...extra,
  };
}

describe("threadPreviewText", () => {
  it("shows the message text", () => {
    expect(threadPreviewText(thread(), t)).toBe("hola");
  });

  it("shows only the FIRST line of a pasted multi-line message", () => {
    const pasted = thread({ lastMessage: lastMessage({ body: "Hola\nsegunda línea" }) });
    expect(threadPreviewText(pasted, t)).toBe("Hola");
  });

  it("names each attachment kind rather than calling them all voice messages", () => {
    // The regression this exists for: every non-text message previewed as
    // "voice message", because the thread query selected the voice path alone.
    expect(
      threadPreviewText(
        thread({ lastMessageKind: "image", lastMessage: lastMessage({ body: null }) }),
        t,
      ),
    ).toBe("Photo");
    expect(
      threadPreviewText(
        thread({ lastMessageKind: "video", lastMessage: lastMessage({ body: null }) }),
        t,
      ),
    ).toBe("Video");
    expect(
      threadPreviewText(
        thread({ lastMessageKind: "voice", lastMessage: lastMessage({ body: null }) }),
        t,
      ),
    ).toBe("Voice message");
  });

  it("prefers a document's own filename over the word 'Document'", () => {
    const withFile = thread({
      lastMessageKind: "file",
      lastMessage: lastMessage({ body: null, fileName: "tarea-3.pdf" }),
    });
    expect(threadPreviewText(withFile, t)).toBe("tarea-3.pdf");
  });

  it("names a tombstone by who deleted it", () => {
    const deletedByTeacher = thread({
      lastMessage: lastMessage({
        senderRole: "teacher",
        body: null,
        deletedAt: "2026-09-05T11:00:00.000Z",
      }),
    });
    expect(threadPreviewText(deletedByTeacher, t)).toBe(t("web.messages.youDeletedThisMessage"));

    const deletedByStudent = thread({
      lastMessage: lastMessage({ body: null, deletedAt: "2026-09-05T11:00:00.000Z" }),
    });
    expect(threadPreviewText(deletedByStudent, t)).toBe(t("web.messages.thisMessageWasDeleted"));
  });

  it("is empty for a conversation with no messages yet", () => {
    expect(threadPreviewText(thread({ lastMessage: null }), t)).toBe("");
  });
});

describe("filterThreadsByName", () => {
  const threads = [
    thread({ studentId: "s1", studentName: "José Ramírez" }),
    thread({ studentId: "s2", studentName: "Marta Ibarra" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterThreadsByName(threads, "   ")).toHaveLength(2);
  });

  it("matches without accents or case — 'jose' must find 'José'", () => {
    expect(filterThreadsByName(threads, "jose").map((x) => x.studentId)).toEqual(["s1"]);
    expect(filterThreadsByName(threads, "RAMIREZ").map((x) => x.studentId)).toEqual(["s1"]);
  });

  it("matches mid-name, not just the start", () => {
    expect(filterThreadsByName(threads, "ibarra").map((x) => x.studentId)).toEqual(["s2"]);
  });

  it("returns nothing when nobody matches", () => {
    expect(filterThreadsByName(threads, "zzz")).toEqual([]);
  });
});

describe("foldForSearch", () => {
  it("strips diacritics and case", () => {
    expect(foldForSearch("JOSÉ Ñuño")).toBe("jose nuno");
  });
});

describe("formatThreadTimestamp", () => {
  const now = new Date("2026-09-05T18:00:00.000Z");
  const tz = "America/Mexico_City";

  it("shows a clock time for today", () => {
    expect(formatThreadTimestamp("2026-09-05T16:30:00.000Z", "en", tz, t, now)).toMatch(/10:30/);
  });

  it("says Yesterday rather than repeating a date", () => {
    expect(formatThreadTimestamp("2026-09-04T16:30:00.000Z", "en", tz, t, now)).toBe(
      t("chat.day.yesterday"),
    );
  });

  it("names the weekday inside the last week", () => {
    // 2026-09-01 is a Tuesday in Mexico City.
    expect(formatThreadTimestamp("2026-09-01T16:30:00.000Z", "en", tz, t, now)).toBe("Tue");
  });

  it("falls back to a date beyond a week, and adds the year beyond this one", () => {
    expect(formatThreadTimestamp("2026-07-16T16:30:00.000Z", "en", tz, t, now)).toBe("Jul 16");
    expect(formatThreadTimestamp("2025-12-16T16:30:00.000Z", "en", tz, t, now)).toContain("2025");
  });

  it("decides the day in the VIEWER's zone, not the server's", () => {
    // 2026-09-06T04:00Z is still 5 September, 22:00, in Mexico City — "today"
    // there, and already tomorrow in UTC.
    expect(formatThreadTimestamp("2026-09-06T04:00:00.000Z", "en", tz, t, now)).toMatch(/10:00/);
  });
});
