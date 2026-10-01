import { beforeEach, describe, expect, it, vi } from "vitest";

// The two site-search index routes. What they must never do is the thing a
// page guard does: answer a missing session with a redirect. The caller is a
// fetch() in the search dialog, which would follow it and fail parsing HTML,
// so a signed-out tab would show "couldn't load" instead of a 401 anyone can
// read. They must also never be cacheable — the body is names and class times.

vi.mock("server-only", () => ({}));

const { ApiAuthError } = await import("@/lib/api/auth");

const requireApiOnboardedTeacher = vi.fn();
const requireApiStudent = vi.fn();
vi.mock("@/lib/api/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/auth")>()),
  requireApiOnboardedTeacher: (req: Request) => requireApiOnboardedTeacher(req),
  requireApiStudent: (req: Request) => requireApiStudent(req),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: async () => "es" }));

const teacherSearchRecords = vi.fn();
vi.mock("@/lib/search/teacher-records", () => ({
  teacherSearchRecords: (ctx: unknown) => teacherSearchRecords(ctx),
}));
const studentSearchRecords = vi.fn();
vi.mock("@/lib/search/student-records", () => ({
  studentSearchRecords: (ctx: unknown) => studentSearchRecords(ctx),
}));

const { GET: teacherGET } = await import("@/app/api/teacher/search/route");
const { GET: studentGET } = await import("@/app/api/student/search/route");

const req = (path: string) => new Request(`https://x.test${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  teacherSearchRecords.mockResolvedValue([
    { id: "student.s1", kind: "student", label: "Ana", href: "/dashboard/students/s1" },
  ]);
  studentSearchRecords.mockResolvedValue([
    { id: "teacher.t1", kind: "teacher", label: "Mira", href: "/my-classes/teachers/t1" },
  ]);
});

describe("GET /api/teacher/search", () => {
  it("401s a caller with no session as JSON rather than redirecting", async () => {
    requireApiOnboardedTeacher.mockRejectedValue(new ApiAuthError(401, "no-session"));
    const res = await teacherGET(req("/api/teacher/search"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, reason: "no-session" });
    expect(teacherSearchRecords).not.toHaveBeenCalled();
  });

  it("indexes the session teacher's records, in her locale, plus the teacher help", async () => {
    const teacher = { id: "t1", timezone: "America/Mexico_City" };
    requireApiOnboardedTeacher.mockResolvedValue(teacher);
    const res = await teacherGET(req("/api/teacher/search"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const [ctx] = teacherSearchRecords.mock.calls[0] as [{ teacher: unknown; locale: string }];
    expect(ctx.teacher).toBe(teacher);
    expect(ctx.locale).toBe("es");

    const { entries } = (await res.json()) as { entries: Array<{ id: string; href: string }> };
    expect(entries[0]?.id).toBe("student.s1");
    const help = entries.filter((e) => e.id.startsWith("help."));
    expect(help.length).toBeGreaterThan(0);
    expect(help.every((e) => e.href.startsWith("/help/teacher/"))).toBe(true);
  });
});

describe("GET /api/student/search", () => {
  it("refuses a session with no student row", async () => {
    requireApiStudent.mockRejectedValue(new ApiAuthError(403, "no-student-row"));
    const res = await studentGET(req("/api/student/search"));
    expect(res.status).toBe(403);
    expect(studentSearchRecords).not.toHaveBeenCalled();
  });

  it("indexes the session student's records plus the student help, uncacheable", async () => {
    const student = { id: "s1", email: "ana@x.test", timezone: null };
    requireApiStudent.mockResolvedValue(student);
    const res = await studentGET(req("/api/student/search"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const [ctx] = studentSearchRecords.mock.calls[0] as [{ student: unknown }];
    expect(ctx.student).toBe(student);
    const { entries } = (await res.json()) as { entries: Array<{ id: string; href: string }> };
    expect(entries[0]?.id).toBe("teacher.t1");
    expect(
      entries
        .filter((e) => e.id.startsWith("help."))
        .every((e) => e.href.startsWith("/help/student/")),
    ).toBe(true);
  });
});
