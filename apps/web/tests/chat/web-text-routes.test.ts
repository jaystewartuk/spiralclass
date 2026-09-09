import { beforeEach, describe, expect, it, vi } from "vitest";

// Web chat text-message routes: /api/chat/{teacher,student}/[id] GET (list +
// mark-read, with/without `before` cursor) and POST (send text). Auth-gating
// (401) is asserted here too since these are cookie-session routes, not the
// bearer /api/mobile family covered by route-auth-gating.

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
  reactions?: Array<{ reactorRole: string; emoji: string }>;
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
    createdAt: new Date("2026-06-28T10:00:00.000Z"),
    readAt: null,
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

const findUnique = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
  teacherId: "t1",
  studentId: "s1",
}));
const findFirst = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
  teacherId: "t1",
  studentId: "s1",
}));
const findMany = vi.fn<(...a: unknown[]) => Promise<MessageRow[]>>(async () => [row()]);
const updateMany = vi.fn<(...a: unknown[]) => Promise<{ count: number }>>(async () => ({
  count: 0,
}));
const create = vi.fn<(...a: unknown[]) => Promise<MessageRow>>(async () => row());
// Backs validateReplyToId's same-thread lookup — defaults to a message in
// the t1/s1 thread; override per-test for the cross-thread rejection case.
const messageFindUnique = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
  teacherId: "t1",
  studentId: "s1",
}));
// Spy on the per-message reaction query: after the N+1 fix the list routes
// preload reactions via `include`, so this must NOT be called from the list GET.
const messageReactionFindMany = vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
    },
    message: {
      findUnique: (...a: unknown[]) => messageFindUnique(...a),
      findMany: (...a: unknown[]) => findMany(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      create: (...a: unknown[]) => create(...a),
    },
    messageReaction: { findMany: (...a: unknown[]) => messageReactionFindMany(...a) },
  },
}));

vi.mock("@/lib/storage/chat-audio", () => ({
  mintChatAudioSignedUrl: vi.fn(async () => "https://cdn.example.com/voice.m4a?t=a"),
}));
vi.mock("@/lib/storage/chat-video", () => ({
  mintChatVideoSignedUrl: vi.fn(async () => "https://cdn.example.com/video.mp4?t=v"),
}));
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueChatMessage: vi.fn(async () => "notif-id"),
  enqueueChatMessageTeacher: vi.fn(async () => "notif-id"),
}));
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: vi.fn(async () => {}),
}));

const trackServerEventMock = vi.fn();
const flushAnalyticsMock = vi.fn(async () => {});
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackServerEventMock,
  flushAnalytics: flushAnalyticsMock,
}));

const { GET: TEACHER_GET, POST: TEACHER_POST } =
  await import("@/app/api/chat/teacher/[studentId]/route");
const { GET: STUDENT_GET, POST: STUDENT_POST } =
  await import("@/app/api/chat/student/[teacherId]/route");

const teacherParams = (studentId = "s1") => ({ params: Promise.resolve({ studentId }) });
const studentParams = (teacherId = "t1") => ({ params: Promise.resolve({ teacherId }) });

function jsonReq(body: unknown, url = "http://test.local/api/chat"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getReq = (url = "http://test.local/api/chat") => new Request(url);

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentTeacher.mockResolvedValue({ id: "t1", onboardingCompleteAt: new Date() });
  getCurrentStudent.mockResolvedValue({ id: "s1" });
  findUnique.mockResolvedValue({ teacherId: "t1", studentId: "s1" });
  findFirst.mockResolvedValue({ teacherId: "t1", studentId: "s1" });
  findMany.mockResolvedValue([row()]);
  updateMany.mockResolvedValue({ count: 0 });
  create.mockResolvedValue(row());
  messageFindUnique.mockResolvedValue({ teacherId: "t1", studentId: "s1" });
});

describe("GET /api/chat/teacher/[studentId]", () => {
  it("401 when not an onboarded teacher", async () => {
    getCurrentTeacher.mockResolvedValueOnce(null);
    const res = await TEACHER_GET(getReq(), teacherParams());
    expect(res.status).toBe(401);
  });

  it("401 when teacher not onboarded", async () => {
    getCurrentTeacher.mockResolvedValueOnce({ id: "t1", onboardingCompleteAt: null });
    const res = await TEACHER_GET(getReq(), teacherParams());
    expect(res.status).toBe(401);
  });

  it("404 when the student is not linked to this teacher", async () => {
    findUnique.mockResolvedValueOnce(null);
    const res = await TEACHER_GET(getReq(), teacherParams());
    expect(res.status).toBe(404);
  });

  it("returns wire messages (incl. voice + video signed URLs) and marks read", async () => {
    findMany.mockResolvedValueOnce([
      row({ id: "m1", body: "text" }),
      row({ id: "m2", body: null, voiceStoragePath: "voice/x", voiceDurationMs: 1000 }),
      row({ id: "m3", body: null, videoStoragePath: "video/x", videoDurationMs: 2000 }),
    ]);
    const res = await TEACHER_GET(getReq(), teacherParams());
    expect(res.status).toBe(200);
    const body: Array<{ id: string; voiceUrl: string | null; videoUrl: string | null }> =
      await res.json();
    expect(body).toHaveLength(3);
    expect(body.find((m) => m.id === "m2")?.voiceUrl).toBe("https://cdn.example.com/voice.m4a?t=a");
    expect(body.find((m) => m.id === "m3")?.videoUrl).toBe("https://cdn.example.com/video.mp4?t=v");
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it("applies the `before` cursor to the findMany filter", async () => {
    await TEACHER_GET(
      getReq("http://test.local/api/chat?before=2026-06-28T09:00:00.000Z"),
      teacherParams(),
    );
    const arg = findMany.mock.calls[0][0] as { where: { createdAt?: { lt: Date } } };
    expect(arg.where.createdAt?.lt).toBeInstanceOf(Date);
  });

  it("preloads reactions in the list query (no per-message N+1) and surfaces them", async () => {
    findMany.mockResolvedValueOnce([
      row({ id: "m1", reactions: [{ reactorRole: "student", emoji: "👍" }] }),
      row({ id: "m2", reactions: [] }),
    ]);
    const res = await TEACHER_GET(getReq(), teacherParams());
    expect(res.status).toBe(200);

    // The single list query must ask for reactions via `include`...
    const arg = findMany.mock.calls[0][0] as { include?: { reactions?: unknown } };
    expect(arg.include?.reactions).toBeTruthy();
    // ...so the per-message reaction lookup (the old N+1) never fires.
    expect(messageReactionFindMany).not.toHaveBeenCalled();

    const body: Array<{ id: string; reactions: Array<{ role: string; emoji: string }> }> =
      await res.json();
    expect(body.find((m) => m.id === "m1")?.reactions).toEqual([{ role: "student", emoji: "👍" }]);
    expect(body.find((m) => m.id === "m2")?.reactions).toEqual([]);
  });
});

describe("POST /api/chat/teacher/[studentId]", () => {
  it("201/200 sends a text message as the teacher", async () => {
    create.mockResolvedValueOnce(row({ id: "new", body: "hello" }));
    const res = await TEACHER_POST(jsonReq({ body: "hello" }), teacherParams());
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ senderRole: "teacher", body: "hello" }),
      }),
    );
  });

  it("400 on empty/invalid body", async () => {
    const res = await TEACHER_POST(jsonReq({ body: "   " }), teacherParams());
    expect(res.status).toBe(400);
  });

  it("400 on non-JSON body", async () => {
    const bad = new Request("http://test.local/api/chat", { method: "POST", body: "not json" });
    const res = await TEACHER_POST(bad, teacherParams());
    expect(res.status).toBe(400);
  });

  it("401 when not onboarded", async () => {
    getCurrentTeacher.mockResolvedValueOnce(null);
    const res = await TEACHER_POST(jsonReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(401);
  });

  it("404 when student not linked", async () => {
    findUnique.mockResolvedValueOnce(null);
    const res = await TEACHER_POST(jsonReq({ body: "x" }), teacherParams());
    expect(res.status).toBe(404);
  });

  it("tracks message_sent (no attachment, recipient is the student) and flushes", async () => {
    create.mockResolvedValueOnce(
      row({ id: "new", teacherId: "t1", studentId: "s1", body: "hello" }),
    );
    await TEACHER_POST(jsonReq({ body: "hello" }), teacherParams());
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "message_sent",
        distinctId: "t1",
        properties: {
          teacherId: "t1",
          conversationId: "t1:s1",
          recipientType: "student",
          hasAttachment: false,
        },
      }),
    );
    expect(flushAnalyticsMock).toHaveBeenCalled();
  });

  it("round-trips a replyToId pointing at a message in the same thread", async () => {
    create.mockResolvedValueOnce(row({ id: "new", body: "reply" }));
    const res = await TEACHER_POST(
      jsonReq({ body: "reply", replyToId: "orig-1" }),
      teacherParams(),
    );
    expect(res.status).toBe(200);
    expect(messageFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "orig-1" } }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ replyToId: "orig-1" }) }),
    );
  });

  it("400s when replyToId points at a message outside this (teacherId, studentId) thread", async () => {
    messageFindUnique.mockResolvedValueOnce({
      teacherId: "other-teacher",
      studentId: "other-student",
    });
    const res = await TEACHER_POST(
      jsonReq({ body: "reply", replyToId: "not-mine" }),
      teacherParams(),
    );
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("400s when replyToId points at a nonexistent message", async () => {
    messageFindUnique.mockResolvedValueOnce(null);
    const res = await TEACHER_POST(jsonReq({ body: "reply", replyToId: "ghost" }), teacherParams());
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("GET /api/chat/student/[teacherId]", () => {
  it("401 when not a student", async () => {
    getCurrentStudent.mockResolvedValueOnce(null);
    const res = await STUDENT_GET(getReq(), studentParams());
    expect(res.status).toBe(401);
  });

  it("404 when teacher not linked (resolves identity ids)", async () => {
    findFirst.mockResolvedValueOnce(null);
    const res = await STUDENT_GET(getReq(), studentParams());
    expect(res.status).toBe(404);
    expect(studentIdentityIds).toHaveBeenCalled();
  });

  it("returns wire messages and marks teacher messages read", async () => {
    findMany.mockResolvedValueOnce([row({ senderRole: "teacher", body: "hi" })]);
    const res = await STUDENT_GET(getReq(), studentParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
    expect(updateMany).toHaveBeenCalledOnce();
  });
});

describe("POST /api/chat/student/[teacherId]", () => {
  it("sends a text message as the student", async () => {
    create.mockResolvedValueOnce(row({ senderRole: "student", body: "hey" }));
    const res = await STUDENT_POST(jsonReq({ body: "hey" }), studentParams());
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ senderRole: "student", body: "hey" }),
      }),
    );
  });

  it("400 on invalid body", async () => {
    const res = await STUDENT_POST(jsonReq({ body: "" }), studentParams());
    expect(res.status).toBe(400);
  });

  it("404 when teacher not linked", async () => {
    findFirst.mockResolvedValueOnce(null);
    const res = await STUDENT_POST(jsonReq({ body: "x" }), studentParams());
    expect(res.status).toBe(404);
  });

  it("tracks message_sent (recipient is the teacher)", async () => {
    create.mockResolvedValueOnce(
      row({ id: "new", teacherId: "t1", studentId: "s1", senderRole: "student", body: "hey" }),
    );
    await STUDENT_POST(jsonReq({ body: "hey" }), studentParams());
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "message_sent",
        distinctId: "s1",
        properties: {
          teacherId: "t1",
          conversationId: "t1:s1",
          recipientType: "teacher",
          hasAttachment: false,
        },
      }),
    );
  });

  it("round-trips a replyToId pointing at a message in the same thread", async () => {
    create.mockResolvedValueOnce(row({ id: "new", senderRole: "student", body: "reply" }));
    const res = await STUDENT_POST(
      jsonReq({ body: "reply", replyToId: "orig-1" }),
      studentParams(),
    );
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ replyToId: "orig-1" }) }),
    );
  });

  it("400s when replyToId points at a message outside this (teacherId, studentId) thread", async () => {
    messageFindUnique.mockResolvedValueOnce({
      teacherId: "other-teacher",
      studentId: "other-student",
    });
    const res = await STUDENT_POST(
      jsonReq({ body: "reply", replyToId: "not-mine" }),
      studentParams(),
    );
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
