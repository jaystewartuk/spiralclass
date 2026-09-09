import { beforeEach, describe, expect, it, vi } from "vitest";

// Web chat thread-list routes: /api/chat/{teacher,student}/threads GET.
// Each runs a single $queryRaw producing per-conversation summaries; assert
// the wire mapping (incl. the video fields on lastMessage), unread counts,
// and auth gating.

type ThreadRow = {
  teacher_id?: string;
  teacher_name?: string;
  student_id: string;
  student_name?: string;
  last_id: string;
  last_sender_role: string;
  last_body: string | null;
  last_voice_storage_path?: string | null;
  last_video_storage_path?: string | null;
  last_image_storage_path?: string | null;
  last_file_storage_path?: string | null;
  last_file_name?: string | null;
  last_created_at: Date;
  last_read_at: Date | null;
  unread_count: bigint;
};

function teacherRow(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    student_id: "s1",
    student_name: "Marco",
    last_id: "m1",
    last_sender_role: "student",
    last_body: "hola",
    last_voice_storage_path: null,
    last_created_at: new Date("2026-06-28T10:00:00.000Z"),
    last_read_at: null,
    unread_count: 3n,
    ...over,
  };
}
function studentRow(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    teacher_id: "t1",
    teacher_name: "Mira",
    student_id: "s1",
    last_id: "m1",
    last_sender_role: "teacher",
    last_body: "nos vemos",
    last_voice_storage_path: null,
    last_created_at: new Date("2026-06-28T09:00:00.000Z"),
    last_read_at: null,
    unread_count: 1n,
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

const queryRaw = vi.fn<(...a: unknown[]) => Promise<ThreadRow[]>>(async () => []);
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) },
}));

const { GET: TEACHER_THREADS } = await import("@/app/api/chat/teacher/threads/route");
const { GET: STUDENT_THREADS } = await import("@/app/api/chat/student/threads/route");

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentTeacher.mockResolvedValue({ id: "t1", onboardingCompleteAt: new Date() });
  getCurrentStudent.mockResolvedValue({ id: "s1" });
});

describe("GET /api/chat/teacher/threads", () => {
  it("401 when not a teacher", async () => {
    getCurrentTeacher.mockResolvedValueOnce(null);
    expect((await TEACHER_THREADS()).status).toBe(401);
  });
  it("401 when teacher not onboarded", async () => {
    getCurrentTeacher.mockResolvedValueOnce({ id: "t1", onboardingCompleteAt: null });
    expect((await TEACHER_THREADS()).status).toBe(401);
  });
  it("maps rows to threads with numeric unread + full lastMessage shape", async () => {
    queryRaw.mockResolvedValueOnce([
      teacherRow(),
      teacherRow({ student_id: "s2", unread_count: 0n }),
    ]);
    const res = await TEACHER_THREADS();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].unreadCount).toBe(3);
    expect(body[0].lastMessage).toMatchObject({
      voiceUrl: null,
      voiceDurationMs: null,
      videoUrl: null,
      videoDurationMs: null,
    });
  });
  it("returns an empty array when there are no threads", async () => {
    queryRaw.mockResolvedValueOnce([]);
    expect(await (await TEACHER_THREADS()).json()).toEqual([]);
  });

  it("names the last message's kind from its stored path, for every kind", async () => {
    // A summary mints no signed URLs, so the kind cannot be read back off
    // `lastMessage`. Before it was carried explicitly, a photo, a video and a
    // document all previewed as "voice message".
    queryRaw.mockResolvedValueOnce([
      teacherRow({ student_id: "s1", last_voice_storage_path: "v/1" }),
      teacherRow({ student_id: "s2", last_video_storage_path: "m/1" }),
      teacherRow({ student_id: "s3", last_image_storage_path: "i/1" }),
      teacherRow({ student_id: "s4", last_file_storage_path: "f/1", last_file_name: "tarea.pdf" }),
      teacherRow({ student_id: "s5" }),
    ]);
    const body = await (await TEACHER_THREADS()).json();
    expect(body.map((t: { lastMessageKind: string }) => t.lastMessageKind)).toEqual([
      "voice",
      "video",
      "image",
      "file",
      "text",
    ]);
    // The filename rides along so a document previews as itself.
    expect(body[3].lastMessage.fileName).toBe("tarea.pdf");
    // ...and no signed URL is minted for any of them.
    expect(body[0].lastMessage.voiceUrl).toBeNull();
    expect(body[2].lastMessage.imageUrl).toBeNull();
  });

  it("reports a deleted message as text — its media columns are nulled at delete time", async () => {
    queryRaw.mockResolvedValueOnce([teacherRow({ last_body: null })]);
    const body = await (await TEACHER_THREADS()).json();
    expect(body[0].lastMessageKind).toBe("text");
  });
});

describe("GET /api/chat/student/threads", () => {
  it("401 when not a student", async () => {
    getCurrentStudent.mockResolvedValueOnce(null);
    expect((await STUDENT_THREADS()).status).toBe(401);
  });
  it("maps rows to student threads (teacherId/teacherName) and resolves identity ids", async () => {
    queryRaw.mockResolvedValueOnce([studentRow()]);
    const res = await STUDENT_THREADS();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toMatchObject({ teacherId: "t1", teacherName: "Mira", unreadCount: 1 });
    expect(body[0].lastMessage.videoUrl).toBeNull();
    expect(body[0].lastMessageKind).toBe("text");
    expect(studentIdentityIds).toHaveBeenCalled();
  });
});
