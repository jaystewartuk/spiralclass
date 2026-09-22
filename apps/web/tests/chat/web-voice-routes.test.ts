import { beforeEach, describe, expect, it, vi } from "vitest";

// Web chat voice routes, now on the presigned direct-to-R2 flow: GET mints an
// upload ticket, POST finalizes a storage path. Covers presign, finalize
// success, validation failures (bad-path / too-large), and auth/ownership.

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
};

const sampleMessage: MessageRow = {
  id: "m1",
  teacherId: "t1",
  studentId: "s1",
  senderRole: "teacher",
  body: null,
  voiceStoragePath: "t1/s1/1.m4a",
  voiceDurationMs: 5000,
  videoStoragePath: null,
  videoDurationMs: null,
  createdAt: new Date("2026-06-28T10:00:00.000Z"),
  readAt: null,
};

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
const create = vi.fn<(...a: unknown[]) => Promise<MessageRow>>(async () => sampleMessage);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
    },
    message: { create: (...a: unknown[]) => create(...a) },
    messageReaction: { findMany: async () => [] },
  },
}));

const presignChatMedia = vi.fn((..._a: unknown[]) => ({
  uploadUrl: "https://acct.r2.cloudflarestorage.com/chat/t1/s1/1.m4a?sig=x",
  storagePath: "t1/s1/1.m4a",
}));
const validateChatMediaUpload = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
vi.mock("@/lib/storage/chat-media", () => ({
  presignChatMedia: (...a: unknown[]) => presignChatMedia(...a),
  validateChatMediaUpload: (...a: unknown[]) => validateChatMediaUpload(...a),
}));

vi.mock("@/lib/storage/chat-audio", () => ({
  mintChatAudioSignedUrl: vi.fn(async () => "https://cdn.example.com/voice.m4a?t=a"),
}));
vi.mock("@/lib/storage/chat-video", () => ({ mintChatVideoSignedUrl: vi.fn(async () => null) }));
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueChatMessage: vi.fn(async () => "notif-id"),
  enqueueChatMessageTeacher: vi.fn(async () => "notif-id"),
}));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn(async () => {}) }));

const TEACHER = await import("@/app/api/chat/teacher/[studentId]/voice/route");
const STUDENT = await import("@/app/api/chat/student/[teacherId]/voice/route");

const STORAGE_PATH = "t1/s1/1.m4a";
const teacherParams = (studentId = "s1") => ({ params: Promise.resolve({ studentId }) });
const studentParams = (teacherId = "t1") => ({ params: Promise.resolve({ teacherId }) });
function jsonReq(body: object): Request {
  return new Request("http://test.local/api/chat/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function getReq(contentType = "audio/mp4"): Request {
  return new Request(
    `http://test.local/api/chat/voice?contentType=${encodeURIComponent(contentType)}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentTeacher.mockResolvedValue({ id: "t1", onboardingCompleteAt: new Date() });
  getCurrentStudent.mockResolvedValue({ id: "s1" });
  findUnique.mockResolvedValue({ teacherId: "t1", studentId: "s1" });
  findFirst.mockResolvedValue({ teacherId: "t1", studentId: "s1" });
  presignChatMedia.mockReturnValue({
    uploadUrl: "https://acct.r2.cloudflarestorage.com/chat/t1/s1/1.m4a?sig=x",
    storagePath: STORAGE_PATH,
  });
  validateChatMediaUpload.mockResolvedValue({ ok: true });
  create.mockResolvedValue(sampleMessage);
});

describe("web teacher voice", () => {
  it("GET 401 when not onboarded", async () => {
    getCurrentTeacher.mockResolvedValueOnce(null);
    expect((await TEACHER.GET(getReq(), teacherParams())).status).toBe(401);
  });
  it("GET returns an upload ticket", async () => {
    const res = await TEACHER.GET(getReq(), teacherParams());
    expect(res.status).toBe(200);
    expect((await res.json()).storagePath).toBe(STORAGE_PATH);
  });
  it("POST 401 when not onboarded", async () => {
    getCurrentTeacher.mockResolvedValueOnce(null);
    expect(
      (await TEACHER.POST(jsonReq({ storagePath: STORAGE_PATH }), teacherParams())).status,
    ).toBe(401);
  });
  it("POST 404 when student not linked", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(
      (await TEACHER.POST(jsonReq({ storagePath: STORAGE_PATH }), teacherParams())).status,
    ).toBe(404);
  });
  it("POST 400 on bad path", async () => {
    validateChatMediaUpload.mockResolvedValueOnce({ ok: false, reason: "bad-path" } as never);
    expect((await TEACHER.POST(jsonReq({ storagePath: "evil" }), teacherParams())).status).toBe(
      400,
    );
  });
  it("POST 413 when too large", async () => {
    validateChatMediaUpload.mockResolvedValueOnce({ ok: false, reason: "too-large" } as never);
    expect(
      (await TEACHER.POST(jsonReq({ storagePath: STORAGE_PATH }), teacherParams())).status,
    ).toBe(413);
  });
  it("POST 200 stores message + returns signed voiceUrl", async () => {
    const res = await TEACHER.POST(
      jsonReq({ storagePath: STORAGE_PATH, durationMs: 5000 }),
      teacherParams(),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).voiceUrl).toBe("https://cdn.example.com/voice.m4a?t=a");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          senderRole: "teacher",
          voiceStoragePath: STORAGE_PATH,
          voiceDurationMs: 5000,
        }),
      }),
    );
  });
  it("POST stores null duration when absent", async () => {
    await TEACHER.POST(jsonReq({ storagePath: STORAGE_PATH }), teacherParams());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ voiceDurationMs: null }) }),
    );
  });
});

describe("web student voice", () => {
  it("POST 401 when not a student", async () => {
    getCurrentStudent.mockResolvedValueOnce(null);
    expect(
      (await STUDENT.POST(jsonReq({ storagePath: STORAGE_PATH }), studentParams())).status,
    ).toBe(401);
  });
  it("POST 404 when teacher not linked (uses identity ids)", async () => {
    findFirst.mockResolvedValueOnce(null);
    const res = await STUDENT.POST(jsonReq({ storagePath: STORAGE_PATH }), studentParams());
    expect(res.status).toBe(404);
    expect(studentIdentityIds).toHaveBeenCalled();
  });
  it("POST 200 sends voice as student", async () => {
    create.mockResolvedValueOnce({ ...sampleMessage, senderRole: "student" });
    const res = await STUDENT.POST(
      jsonReq({ storagePath: STORAGE_PATH, durationMs: 3000 }),
      studentParams(),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).senderRole).toBe("student");
  });
});
