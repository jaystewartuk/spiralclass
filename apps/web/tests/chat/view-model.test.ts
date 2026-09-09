import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@spiralclass/shared";
import {
  CHAT_PAGE_SIZE,
  buildChatRows,
  dropPendingMessage,
  formatElapsed,
  formatFileSize,
  groupRowsByDay,
  isPendingMessage,
  isScrolledToBottom,
  mergeChatMessages,
  newPendingId,
  prependChatMessages,
  replacePendingMessage,
  unseenSince,
} from "@/lib/chat/view-model";

function msg(
  id: string,
  senderRole: "teacher" | "student",
  createdAt: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    senderRole,
    body: `body-${id}`,
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
    createdAt,
    readAt: null,
    editedAt: null,
    deletedAt: null,
    reactions: [],
    ...extra,
  };
}

describe("buildChatRows", () => {
  it("opens a run on the first message and closes it on the last", () => {
    const rows = buildChatRows([msg("a", "student", "2026-09-01T10:00:00.000Z")]);
    expect(rows[0]).toMatchObject({ startsDay: true, startsRun: true, endsRun: true });
  });

  it("groups consecutive messages from one sender inside the gap window", () => {
    const rows = buildChatRows([
      msg("a", "student", "2026-09-01T10:00:00.000Z"),
      msg("b", "student", "2026-09-01T10:01:00.000Z"),
      msg("c", "student", "2026-09-01T10:02:00.000Z"),
    ]);
    expect(rows.map((r) => r.startsRun)).toEqual([true, false, false]);
    expect(rows.map((r) => r.endsRun)).toEqual([false, false, true]);
  });

  it("breaks the run when the sender changes", () => {
    const rows = buildChatRows([
      msg("a", "student", "2026-09-01T10:00:00.000Z"),
      msg("b", "teacher", "2026-09-01T10:00:30.000Z"),
    ]);
    expect(rows.map((r) => r.startsRun)).toEqual([true, true]);
    expect(rows.map((r) => r.endsRun)).toEqual([true, true]);
  });

  it("breaks the run after a long pause, even from the same sender", () => {
    const rows = buildChatRows([
      msg("a", "student", "2026-09-01T10:00:00.000Z"),
      msg("b", "student", "2026-09-01T10:06:00.000Z"),
    ]);
    expect(rows.map((r) => r.startsRun)).toEqual([true, true]);
  });

  it("starts a new day, and a new run, across a calendar boundary", () => {
    // Local-day boundaries, built from local components so the assertion does
    // not depend on the runner's zone.
    const monday = new Date(2026, 8, 1, 23, 58);
    const tuesday = new Date(2026, 8, 2, 0, 1);
    const rows = buildChatRows([
      msg("a", "student", monday.toISOString()),
      msg("b", "student", tuesday.toISOString()),
    ]);
    expect(rows.map((r) => r.startsDay)).toEqual([true, true]);
    expect(rows.map((r) => r.startsRun)).toEqual([true, true]);
  });
});

describe("mergeChatMessages", () => {
  it("takes the incoming page wholesale when nothing is loaded yet", () => {
    const incoming = [msg("a", "student", "2026-09-01T10:00:00.000Z")];
    expect(mergeChatMessages([], incoming)).toBe(incoming);
  });

  it("keeps object identity for a message that did not change", () => {
    const existing = msg("a", "student", "2026-09-01T10:00:00.000Z");
    const polled = msg("a", "student", "2026-09-01T10:00:00.000Z");
    const merged = mergeChatMessages([existing], [polled]);
    expect(merged[0]).toBe(existing);
  });

  it("adopts a change, and only then a new object", () => {
    const existing = msg("a", "student", "2026-09-01T10:00:00.000Z");
    const polled = msg("a", "student", "2026-09-01T10:00:00.000Z", {
      readAt: "2026-09-01T10:05:00.000Z",
    });
    const merged = mergeChatMessages([existing], [polled]);
    expect(merged[0]).not.toBe(existing);
    expect(merged[0].readAt).toBe("2026-09-01T10:05:00.000Z");
  });

  it("keeps the signed media URL already issued, so playback does not restart", () => {
    const existing = msg("a", "student", "2026-09-01T10:00:00.000Z", {
      voiceUrl: "https://r2/first?sig=1",
      voiceDurationMs: 4000,
    });
    const polled = msg("a", "student", "2026-09-01T10:00:00.000Z", {
      voiceUrl: "https://r2/first?sig=2",
      voiceDurationMs: 4000,
    });
    expect(mergeChatMessages([existing], [polled])[0]).toBe(existing);
  });

  it("does not resurrect media on a delete-for-everyone tombstone", () => {
    const existing = msg("a", "student", "2026-09-01T10:00:00.000Z", {
      voiceUrl: "https://r2/first",
    });
    const polled = msg("a", "student", "2026-09-01T10:00:00.000Z", {
      body: null,
      voiceUrl: null,
      deletedAt: "2026-09-01T10:09:00.000Z",
    });
    expect(mergeChatMessages([existing], [polled])[0].voiceUrl).toBeNull();
  });

  it("preserves older messages the reader paged in", () => {
    const older = msg("old", "teacher", "2026-08-30T10:00:00.000Z");
    const recent = msg("new", "teacher", "2026-09-01T10:00:00.000Z");
    const merged = mergeChatMessages([older, recent], [recent]);
    expect(merged.map((m) => m.id)).toEqual(["old", "new"]);
  });

  it("retires an optimistic message once the server's copy arrives", () => {
    const pending = msg(`${newPendingId()}`, "student", "2026-09-01T10:00:00.000Z", {
      body: "hola",
    });
    const saved = msg("server-1", "student", "2026-09-01T10:00:01.000Z", { body: "hola" });
    const merged = mergeChatMessages([pending], [saved]);
    expect(merged.map((m) => m.id)).toEqual(["server-1"]);
  });

  it("keeps an optimistic message whose server copy has not landed", () => {
    const pending = msg(newPendingId(), "student", "2026-09-01T10:00:00.000Z", { body: "hola" });
    const other = msg("server-1", "teacher", "2026-09-01T09:59:00.000Z", { body: "buenas" });
    const merged = mergeChatMessages([pending], [other]);
    expect(merged).toHaveLength(2);
    expect(isPendingMessage(merged[1])).toBe(true);
  });

  it("sorts the result by time", () => {
    const a = msg("a", "student", "2026-09-01T10:00:00.000Z");
    const b = msg("b", "teacher", "2026-09-01T09:00:00.000Z");
    expect(mergeChatMessages([a], [a, b]).map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("prependChatMessages", () => {
  it("splices an older page ahead of what is loaded", () => {
    const loaded = [msg("c", "student", "2026-09-01T10:00:00.000Z")];
    const older = [
      msg("a", "student", "2026-09-01T08:00:00.000Z"),
      msg("b", "teacher", "2026-09-01T09:00:00.000Z"),
    ];
    expect(prependChatMessages(loaded, older).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op — same array — when the page adds nothing new", () => {
    const loaded = [msg("a", "student", "2026-09-01T10:00:00.000Z")];
    expect(prependChatMessages(loaded, [])).toBe(loaded);
    expect(prependChatMessages(loaded, [msg("a", "student", "2026-09-01T10:00:00.000Z")])).toBe(
      loaded,
    );
  });
});

describe("optimistic message helpers", () => {
  it("mints ids that are recognisably pending and never collide", () => {
    const first = newPendingId();
    const second = newPendingId();
    expect(first).not.toBe(second);
    expect(isPendingMessage({ id: first })).toBe(true);
    expect(isPendingMessage({ id: "server-1" })).toBe(false);
  });

  it("swaps the optimistic message for the saved one, in order", () => {
    const pendingId = newPendingId();
    const prev = [
      msg("a", "teacher", "2026-09-01T09:00:00.000Z"),
      msg(pendingId, "student", "2026-09-01T10:00:00.000Z"),
    ];
    const saved = msg("server-1", "student", "2026-09-01T10:00:00.500Z");
    expect(replacePendingMessage(prev, pendingId, saved).map((m) => m.id)).toEqual([
      "a",
      "server-1",
    ]);
  });

  it("never leaves both the optimistic and the saved copy on screen", () => {
    const pendingId = newPendingId();
    const saved = msg("server-1", "student", "2026-09-01T10:00:00.500Z");
    const prev = [msg(pendingId, "student", "2026-09-01T10:00:00.000Z"), saved];
    expect(replacePendingMessage(prev, pendingId, saved)).toHaveLength(1);
  });

  it("drops the optimistic message when the send fails", () => {
    const pendingId = newPendingId();
    const prev = [msg("a", "teacher", "2026-09-01T09:00:00.000Z"), msg(pendingId, "student", "x")];
    expect(dropPendingMessage(prev, pendingId).map((m) => m.id)).toEqual(["a"]);
  });
});

describe("unseenSince", () => {
  const messages = [
    msg("a", "teacher", "2026-09-01T10:00:00.000Z"),
    msg("b", "teacher", "2026-09-01T10:01:00.000Z"),
    msg("c", "teacher", "2026-09-01T10:02:00.000Z"),
  ];

  it("counts what arrived after the last seen message", () => {
    expect(unseenSince(messages, "a")).toBe(2);
    expect(unseenSince(messages, "c")).toBe(0);
  });

  it("counts nothing before the first paint has happened", () => {
    expect(unseenSince(messages, null)).toBe(0);
  });

  it("falls back to the whole list when the marker has scrolled out of it", () => {
    expect(unseenSince(messages, "gone")).toBe(3);
  });
});

describe("isScrolledToBottom", () => {
  it("treats a small gap as still following the conversation", () => {
    expect(isScrolledToBottom({ scrollHeight: 1000, scrollTop: 910, clientHeight: 50 })).toBe(true);
  });

  it("treats a real scroll-up as reading history", () => {
    expect(isScrolledToBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 50 })).toBe(
      false,
    );
  });
});

describe("formatElapsed", () => {
  it("pads the seconds and rolls over at a minute", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9_000)).toBe("0:09");
    expect(formatElapsed(61_500)).toBe("1:01");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("formatFileSize", () => {
  it("scales the unit to the size", () => {
    expect(formatFileSize(512, "en")).toBe("512 B");
    expect(formatFileSize(2048, "en")).toBe("2 KB");
    expect(formatFileSize(3 * 1024 * 1024, "en")).toBe("3.0 MB");
  });

  it("uses the reader's own decimal separator", () => {
    // The previous implementation hardcoded `.`, which is a comma in most of
    // the locales this app ships in.
    expect(formatFileSize(1.5 * 1024 * 1024, "fr")).toContain(",");
  });

  it("says nothing when the size is unknown", () => {
    expect(formatFileSize(null, "en")).toBe("");
    expect(formatFileSize(Number.NaN, "en")).toBe("");
  });
});

describe("CHAT_PAGE_SIZE", () => {
  it("mirrors the server's page size, which is how 'there is more' is decided", () => {
    expect(CHAT_PAGE_SIZE).toBe(50);
  });
});

describe("groupRowsByDay", () => {
  it("puts each calendar day in its own section, so the divider can stick", () => {
    const monday = new Date(2026, 8, 1, 9, 0);
    const mondayLater = new Date(2026, 8, 1, 18, 0);
    const tuesday = new Date(2026, 8, 2, 9, 0);
    const sections = groupRowsByDay(
      buildChatRows([
        msg("a", "student", monday.toISOString()),
        msg("b", "teacher", mondayLater.toISOString()),
        msg("c", "student", tuesday.toISOString()),
      ]),
    );
    expect(sections.map((s) => s.rows.map((r) => r.message.id))).toEqual([["a", "b"], ["c"]]);
    expect(sections.map((s) => s.key)).toEqual(["a", "c"]);
  });

  it("has nothing to group when the thread is empty", () => {
    expect(groupRowsByDay([])).toEqual([]);
  });
});
