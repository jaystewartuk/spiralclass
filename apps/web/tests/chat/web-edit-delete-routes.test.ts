import { beforeEach, describe, expect, it, vi } from "vitest";

// Web chat edit/delete routes: PATCH + DELETE /api/chat/{teacher,student}/[id]/[messageId].
// WhatsApp semantics enforced by lib/chat/message-actions.ts: sender-only, text-only
// edit inside a 15-min window, delete-for-everyone tombstone inside its own window
// (media object removed from R2, content columns nulled, row kept). Writes are
// conditional (updateMany where deletedAt: null) so an edit can never land on a
// tombstone, and a delete retracts the message's chat notification rows.

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

const getCurrentTeacher = vi.fn<
  () => Promise<{ id: string; onboardingCompleteAt: Date | null } | null>
>(async () => ({
  id: "t1",
  onboardingCompleteAt: new Date(),
}));
const getCurrentStudent = vi.fn<() => Promise<{ id: string } | null>>(async () => ({ id: "s1" }));
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentTeacher, getCurrentStudent };
});

const studentIdentityIds = vi.fn(async () => ["s1"]);
vi.mock("@/lib/students/identity", () => ({ studentIdentityIds }));

const tsFindUnique = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
  teacherId: "t1",
  studentId: "s1",
}));
const tsFindFirst = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
  teacherId: "t1",
  studentId: "s1",
}));
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
    teacherStudent: {
      findUnique: (...a: unknown[]) => tsFindUnique(...a),
      findFirst: (...a: unknown[]) => tsFindFirst(...a),
    },
    message: {
      findFirst: (...a: unknown[]) => messageFindFirst(...a),
      updateMany: (...a: unknown[]) => messageUpdateMany(...a),
    },
    notification: {
      findMany: (...a: unknown[]) => notificationFindMany(...a),
      update: (...a: unknown[]) => notificationUpdate(...a),
      deleteMany: (...a: unknown[]) => notificationDeleteMany(...a),
    },
    messageReaction: { findMany: async () => [] },
  },
}));

const deleteChatAudioObject = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("@/lib/storage/chat-audio", () => ({
  mintChatAudioSignedUrl: vi.fn(async () => "https://cdn.example.com/voice.m4a?t=a"),
  deleteChatAudioObject: (...a: unknown[]) => deleteChatAudioObject(...a),
}));
const deleteChatVideoObject = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("@/lib/storage/chat-video", () => ({
  mintChatVideoSignedUrl: vi.fn(async () => "https://cdn.example.com/video.mp4?t=v"),
  deleteChatVideoObject: (...a: unknown[]) => deleteChatVideoObject(...a),
}));

const { PATCH: TEACHER_PATCH, DELETE: TEACHER_DELETE } =
  await import("@/app/api/chat/teacher/[studentId]/[messageId]/route");
const { PATCH: STUDENT_PATCH, DELETE: STUDENT_DELETE } =
  await import("@/app/api/chat/student/[teacherId]/[messageId]/route");

const teacherParams = (studentId = "s1", messageId = "m1") => ({
  params: Promise.resolve({ studentId, messageId }),
});
const studentParams = (teacherId = "t1", messageId = "m1") => ({
  params: Promise.resolve({ teacherId, messageId }),
});

function patchReq(body: unknown): Request {
  return new Request("http://test.local/api/chat", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const deleteReq = () => new Request("http://test.local/api/chat", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentTeacher.mockResolvedValue({ id: "t1", onboardingCompleteAt: new Date() });
  getCurrentStudent.mockResolvedValue({ id: "s1" });
  studentIdentityIds.mockResolvedValue(["s1"]);
  tsFindUnique.mockResolvedValue({ teacherId: "t1", studentId: "s1" });
  tsFindFirst.mockResolvedValue({ teacherId: "t1", studentId: "s1" });
  messageFindFirst.mockResolvedValue(row());
  messageUpdateMany.mockResolvedValue({ count: 1 });
  notificationFindMany.mockResolvedValue([]);
  notificationDeleteMany.mockResolvedValue({ count: 0 });
  deleteChatAudioObject.mockResolvedValue(true);
  deleteChatVideoObject.mockResolvedValue(true);
});

describe("PATCH /api/chat/teacher/[studentId]/[messageId]", () => {
  it("401 when not an onboarded teacher", async () => {
    getCurrentTeacher.mockResolvedValueOnce(null);
    const res = await TEACHER_PATCH(patchReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(401);
  });

  it("404 when the student is not linked to this teacher", async () => {
    tsFindUnique.mockResolvedValueOnce(null);
    const res = await TEACHER_PATCH(patchReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(404);
  });

  it("404 when the message doesn't exist in this thread", async () => {
    messageFindFirst.mockResolvedValueOnce(null);
    const res = await TEACHER_PATCH(patchReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(404);
  });

  it("400 on empty body", async () => {
    const res = await TEACHER_PATCH(patchReq({ body: "   " }), teacherParams());
    expect(res.status).toBe(400);
  });

  it("edits an own fresh text message and stamps editedAt (conditional write)", async () => {
    messageFindFirst.mockResolvedValueOnce(row());
    const res = await TEACHER_PATCH(patchReq({ body: "fixed" }), teacherParams());
    expect(res.status).toBe(200);
    const wire = (await res.json()) as { body: string; editedAt: string | null };
    expect(wire.body).toBe("fixed");
    expect(wire.editedAt).not.toBeNull();
    expect(messageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1", deletedAt: null },
        data: expect.objectContaining({ body: "fixed", editedAt: expect.any(Date) }),
      }),
    );
  });

  it("refreshes the chat notification preview after an edit", async () => {
    notificationFindMany.mockResolvedValueOnce([
      { id: "n1", metadata: { preview: "hi", messageId: "m1" } },
    ]);
    const res = await TEACHER_PATCH(patchReq({ body: "fixed" }), teacherParams());
    expect(res.status).toBe(200);
    expect(notificationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          metadata: { path: ["messageId"], equals: "m1" },
        }),
      }),
    );
    expect(notificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "n1" },
        data: { metadata: expect.objectContaining({ preview: "fixed", messageId: "m1" }) },
      }),
    );
  });

  it("no-op edit (unchanged body) returns 200 without writing", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ body: "same" }));
    const res = await TEACHER_PATCH(patchReq({ body: "same" }), teacherParams());
    expect(res.status).toBe(200);
    expect(messageUpdateMany).not.toHaveBeenCalled();
  });

  it("409 when a concurrent delete tombstoned the row between read and write", async () => {
    messageUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await TEACHER_PATCH(patchReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("not-editable");
  });

  it("403 not-sender when the message was sent by the student", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ senderRole: "student" }));
    const res = await TEACHER_PATCH(patchReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("not-sender");
  });

  it("403 once the 15-minute edit window has passed", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ createdAt: new Date(Date.now() - 16 * 60_000) }));
    const res = await TEACHER_PATCH(patchReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("edit-window-expired");
  });

  it("409 not-editable for a voice message", async () => {
    messageFindFirst.mockResolvedValueOnce(
      row({ body: null, voiceStoragePath: "t1/s1/1.m4a", voiceDurationMs: 3000 }),
    );
    const res = await TEACHER_PATCH(patchReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("not-editable");
  });

  it("409 not-editable for an already-deleted message", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ body: null, deletedAt: new Date() }));
    const res = await TEACHER_PATCH(patchReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/chat/teacher/[studentId]/[messageId]", () => {
  it("tombstones an own text message (content nulled, deletedAt set)", async () => {
    messageFindFirst.mockResolvedValueOnce(row());
    const res = await TEACHER_DELETE(deleteReq(), teacherParams());
    expect(res.status).toBe(200);
    const wire = (await res.json()) as { body: string | null; deletedAt: string | null };
    expect(wire.body).toBeNull();
    expect(wire.deletedAt).not.toBeNull();
    expect(messageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1", deletedAt: null },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          body: null,
          voiceStoragePath: null,
          voiceDurationMs: null,
          videoStoragePath: null,
          videoDurationMs: null,
        }),
      }),
    );
  });

  it("retracts the message's chat notification rows (inbox + pending email fallback)", async () => {
    messageFindFirst.mockResolvedValueOnce(row());
    const res = await TEACHER_DELETE(deleteReq(), teacherParams());
    expect(res.status).toBe(200);
    expect(notificationDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teacherId: "t1",
          templateName: { in: ["chat_message", "chat_message_teacher"] },
          metadata: { path: ["messageId"], equals: "m1" },
        }),
      }),
    );
  });

  it("removes the R2 object when deleting a voice message", async () => {
    messageFindFirst.mockResolvedValueOnce(
      row({ body: null, voiceStoragePath: "t1/s1/1.m4a", voiceDurationMs: 3000 }),
    );
    const res = await TEACHER_DELETE(deleteReq(), teacherParams());
    expect(res.status).toBe(200);
    expect(deleteChatAudioObject).toHaveBeenCalledWith("t1/s1/1.m4a");
  });

  it("removes the R2 object when deleting a video message", async () => {
    messageFindFirst.mockResolvedValueOnce(
      row({ body: null, videoStoragePath: "video/t1/s1/1.mp4", videoDurationMs: 8000 }),
    );
    const res = await TEACHER_DELETE(deleteReq(), teacherParams());
    expect(res.status).toBe(200);
    expect(deleteChatVideoObject).toHaveBeenCalledWith("video/t1/s1/1.mp4");
  });

  it("still tombstones when the R2 cleanup fails (best-effort)", async () => {
    deleteChatAudioObject.mockResolvedValueOnce(false);
    messageFindFirst.mockResolvedValueOnce(
      row({ body: null, voiceStoragePath: "t1/s1/1.m4a", voiceDurationMs: 3000 }),
    );
    const res = await TEACHER_DELETE(deleteReq(), teacherParams());
    expect(res.status).toBe(200);
    expect(messageUpdateMany).toHaveBeenCalled();
  });

  it("is idempotent: re-deleting a tombstone returns 200 without writing", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ body: null, deletedAt: new Date() }));
    const res = await TEACHER_DELETE(deleteReq(), teacherParams());
    expect(res.status).toBe(200);
    expect(messageUpdateMany).not.toHaveBeenCalled();
  });

  it("403 not-sender for the other party's message", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ senderRole: "student" }));
    const res = await TEACHER_DELETE(deleteReq(), teacherParams());
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("not-sender");
  });

  it("403 once the delete window has passed", async () => {
    messageFindFirst.mockResolvedValueOnce(
      row({ createdAt: new Date(Date.now() - 61 * 60 * 60_000) }),
    );
    const res = await TEACHER_DELETE(deleteReq(), teacherParams());
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("delete-window-expired");
  });

  it("401 when not signed in", async () => {
    getCurrentTeacher.mockResolvedValueOnce(null);
    const res = await TEACHER_DELETE(deleteReq(), teacherParams());
    expect(res.status).toBe(401);
  });
});

describe("PATCH/DELETE /api/chat/student/[teacherId]/[messageId]", () => {
  it("edits the student's own message (identity ids resolved)", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ senderRole: "student", body: "hey" }));
    const res = await STUDENT_PATCH(patchReq({ body: "hey!" }), studentParams());
    expect(res.status).toBe(200);
    expect(studentIdentityIds).toHaveBeenCalled();
  });

  it("403 when a student tries to edit the teacher's message", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ senderRole: "teacher" }));
    const res = await STUDENT_PATCH(patchReq({ body: "x" }), studentParams());
    expect(res.status).toBe(403);
  });

  it("tombstones the student's own message", async () => {
    messageFindFirst.mockResolvedValueOnce(row({ senderRole: "student" }));
    const res = await STUDENT_DELETE(deleteReq(), studentParams());
    expect(res.status).toBe(200);
  });

  it("401 when not a student", async () => {
    getCurrentStudent.mockResolvedValue(null);
    const res = await STUDENT_DELETE(deleteReq(), studentParams());
    expect(res.status).toBe(401);
  });

  it("404 when the teacher is not linked", async () => {
    tsFindFirst.mockResolvedValueOnce(null);
    const res = await STUDENT_PATCH(patchReq({ body: "x" }), studentParams());
    expect(res.status).toBe(404);
  });
});
