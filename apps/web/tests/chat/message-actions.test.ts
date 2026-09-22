import { beforeEach, describe, expect, it, vi } from "vitest";

// Perf follow-up #5: editChatMessage/deleteChatMessage used to follow their
// conditional `message.updateMany` with a second `message.findFirst` just to
// hand the caller back the row it already knew the shape of — two round-trips
// where one suffices. These pin the NEW behavior (exactly one findFirst per
// call, the auth-check read) while keeping the existing behavior (correct
// returned message shape, race handling, idempotency) intact.

type MessageRow = {
  id: string;
  teacherId: string;
  studentId: string;
  senderRole: string;
  body: string | null;
  voiceStoragePath: string | null;
  voiceDurationMs: number | null;
  videoStoragePath: string | null;
  videoDurationMs: number | null;
  createdAt: Date;
  readAt: Date | null;
  editedAt: Date | null;
  deletedAt: Date | null;
};

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "m1",
    teacherId: "t1",
    studentId: "s1",
    senderRole: "teacher",
    body: "hi",
    voiceStoragePath: null,
    voiceDurationMs: null,
    videoStoragePath: null,
    videoDurationMs: null,
    createdAt: new Date(Date.now() - 60_000), // 1 min ago — inside both windows
    readAt: null,
    editedAt: null,
    deletedAt: null,
    ...over,
  };
}

const messageFindFirst = vi.fn<(...a: unknown[]) => Promise<MessageRow | null>>(async () => row());
const messageUpdateMany = vi.fn<(...a: unknown[]) => Promise<{ count: number }>>(async () => ({
  count: 1,
}));
const notificationFindMany = vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []);
const notificationUpdate = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({}));
const notificationDeleteMany = vi.fn<(...a: unknown[]) => Promise<{ count: number }>>(async () => ({
  count: 0,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: {
      findFirst: (...a: unknown[]) => messageFindFirst(...a),
      updateMany: (...a: unknown[]) => messageUpdateMany(...a),
    },
    notification: {
      findMany: (...a: unknown[]) => notificationFindMany(...a),
      update: (...a: unknown[]) => notificationUpdate(...a),
      deleteMany: (...a: unknown[]) => notificationDeleteMany(...a),
    },
  },
}));

const deleteChatAudioObject = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("@/lib/storage/chat-audio", () => ({
  deleteChatAudioObject: (...a: unknown[]) => deleteChatAudioObject(...a),
}));
const deleteChatVideoObject = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("@/lib/storage/chat-video", () => ({
  deleteChatVideoObject: (...a: unknown[]) => deleteChatVideoObject(...a),
}));

const { editChatMessage, deleteChatMessage } = await import("@/lib/chat/message-actions");

beforeEach(() => {
  vi.clearAllMocks();
  messageFindFirst.mockResolvedValue(row());
  messageUpdateMany.mockResolvedValue({ count: 1 });
  notificationFindMany.mockResolvedValue([]);
  notificationDeleteMany.mockResolvedValue({ count: 0 });
  deleteChatAudioObject.mockResolvedValue(true);
  deleteChatVideoObject.mockResolvedValue(true);
});

describe("editChatMessage", () => {
  it("issues exactly one message.findFirst (no re-fetch after the write)", async () => {
    const res = await editChatMessage({
      teacherId: "t1",
      studentId: "s1",
      messageId: "m1",
      senderRole: "teacher",
      body: "fixed",
    });
    expect(res.ok).toBe(true);
    expect(messageFindFirst).toHaveBeenCalledTimes(1);
  });

  it("returns the edited body/editedAt without a second query", async () => {
    const original = row();
    messageFindFirst.mockResolvedValueOnce(original);
    const now = new Date(original.createdAt.getTime() + 1000);
    const res = await editChatMessage({
      teacherId: "t1",
      studentId: "s1",
      messageId: "m1",
      senderRole: "teacher",
      body: "fixed",
      now,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message.body).toBe("fixed");
      expect(res.message.editedAt).toEqual(now);
      // Every other field carries over from the originally-read row.
      expect(res.message.id).toBe("m1");
      expect(res.message.createdAt).toEqual(original.createdAt);
    }
  });

  it("409 when a concurrent delete wins the race (updateMany count 0), no re-fetch attempted", async () => {
    messageUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await editChatMessage({
      teacherId: "t1",
      studentId: "s1",
      messageId: "m1",
      senderRole: "teacher",
      body: "fixed",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-editable");
    expect(messageFindFirst).toHaveBeenCalledTimes(1);
  });

  it("no-op edit (unchanged body) never writes and never re-fetches", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ body: "same" }));
    const res = await editChatMessage({
      teacherId: "t1",
      studentId: "s1",
      messageId: "m1",
      senderRole: "teacher",
      body: "same",
    });
    expect(res.ok).toBe(true);
    expect(messageUpdateMany).not.toHaveBeenCalled();
    expect(messageFindFirst).toHaveBeenCalledTimes(1);
  });
});

describe("deleteChatMessage", () => {
  it("issues exactly one message.findFirst (no re-fetch after the write)", async () => {
    const res = await deleteChatMessage({
      teacherId: "t1",
      studentId: "s1",
      messageId: "m1",
      senderRole: "teacher",
    });
    expect(res.ok).toBe(true);
    expect(messageFindFirst).toHaveBeenCalledTimes(1);
  });

  it("returns a fully-tombstoned message without a second query", async () => {
    const original = row();
    messageFindFirst.mockResolvedValueOnce(original);
    const now = new Date(original.createdAt.getTime() + 1000);
    const res = await deleteChatMessage({
      teacherId: "t1",
      studentId: "s1",
      messageId: "m1",
      senderRole: "teacher",
      now,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message.deletedAt).toEqual(now);
      expect(res.message.body).toBeNull();
      expect(res.message.voiceStoragePath).toBeNull();
      expect(res.message.videoStoragePath).toBeNull();
    }
  });

  it("is idempotent for an already-deleted row and still doesn't re-fetch", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ body: null, deletedAt: new Date() }));
    const res = await deleteChatMessage({
      teacherId: "t1",
      studentId: "s1",
      messageId: "m1",
      senderRole: "teacher",
    });
    expect(res.ok).toBe(true);
    expect(messageUpdateMany).not.toHaveBeenCalled();
    expect(messageFindFirst).toHaveBeenCalledTimes(1);
  });
});
