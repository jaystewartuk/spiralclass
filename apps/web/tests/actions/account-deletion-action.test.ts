import { beforeEach, describe, expect, it, vi } from "vitest";

// Two-step self-serve account deletion (credential handling). The actions file the
// 30-day-grace request and cancel it. The consumer-rights guard is the
// key behaviour: deletion is blocked while there are active packages with
// classes remaining (teacher and student paths), and the student path is
// identity-set aware.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/server", () => ({
  auth: { api: { signOut: vi.fn() } },
}));

const state = {
  teacherHasActive: false,
  studentHasActive: false,
  studentEmail: "mira@x.com" as string | null,
};

vi.mock("@/lib/auth", () => ({
  requireTeacher: vi.fn(async () => ({ id: "t1", email: "t@x.com" })),
  requireStudent: vi.fn(async () => ({ id: "s1", email: state.studentEmail })),
}));
vi.mock("@/lib/students/identity", () => ({
  studentComplianceIds: vi.fn(async () => ["s1", "s2"]),
}));

const fileTeacherDeletionRequest = vi.fn(async () => {});
const cancelTeacherDeletionRequests = vi.fn(async () => {});
const fileStudentDeletionRequests = vi.fn(async (_arg: { studentIds: string[] }) => {});
const cancelStudentDeletionRequests = vi.fn(async () => {});
const teacherHasUnusedActivePackages = vi.fn(async () => state.teacherHasActive);
const studentsHaveUnusedActivePackages = vi.fn(async () => state.studentHasActive);
vi.mock("@/lib/account-deletion/requests", () => ({
  DELETION_GRACE_PERIOD_MS: 30 * 24 * 60 * 60 * 1000,
  fileTeacherDeletionRequest,
  cancelTeacherDeletionRequests,
  fileStudentDeletionRequests,
  cancelStudentDeletionRequests,
  teacherHasUnusedActivePackages,
  studentsHaveUnusedActivePackages,
}));

const {
  requestTeacherDeletionAction,
  cancelTeacherDeletionAction,
  requestStudentDeletionAction,
  cancelStudentDeletionAction,
} = await import("@/app/actions/account-deletion");

beforeEach(() => {
  vi.clearAllMocks();
  state.teacherHasActive = false;
  state.studentHasActive = false;
  state.studentEmail = "mira@x.com";
});

describe("requestTeacherDeletionAction", () => {
  it("blocks while the teacher has active packages with classes left", async () => {
    state.teacherHasActive = true;
    const res = await requestTeacherDeletionAction(undefined, new FormData());
    expect(res).toHaveProperty("error");
    expect(fileTeacherDeletionRequest).not.toHaveBeenCalled();
  });

  it("files a request when there are no active packages", async () => {
    const res = await requestTeacherDeletionAction(undefined, new FormData());
    expect(res).toEqual({ ok: true });
    expect(fileTeacherDeletionRequest).toHaveBeenCalledTimes(1);
  });
});

describe("cancelTeacherDeletionAction", () => {
  it("cancels the teacher's pending requests", async () => {
    expect(await cancelTeacherDeletionAction(undefined, new FormData())).toEqual({ ok: true });
    expect(cancelTeacherDeletionRequests).toHaveBeenCalledWith("t1");
  });
});

describe("requestStudentDeletionAction", () => {
  it("refuses when the student has no email on file", async () => {
    state.studentEmail = null;
    const res = await requestStudentDeletionAction(undefined, new FormData());
    expect(res).toHaveProperty("error");
    expect(fileStudentDeletionRequests).not.toHaveBeenCalled();
  });

  it("blocks while any identity row has classes left", async () => {
    state.studentHasActive = true;
    const res = await requestStudentDeletionAction(undefined, new FormData());
    expect(res).toHaveProperty("error");
    expect(studentsHaveUnusedActivePackages).toHaveBeenCalledWith(["s1", "s2"]);
  });

  it("files requests across the whole identity set", async () => {
    const res = await requestStudentDeletionAction(undefined, new FormData());
    expect(res).toEqual({ ok: true });
    const arg = fileStudentDeletionRequests.mock.calls[0][0] as { studentIds: string[] };
    expect(arg.studentIds).toEqual(["s1", "s2"]);
  });
});

describe("cancelStudentDeletionAction", () => {
  it("cancels across the identity set", async () => {
    expect(await cancelStudentDeletionAction(undefined, new FormData())).toEqual({ ok: true });
    expect(cancelStudentDeletionRequests).toHaveBeenCalledWith(["s1", "s2"]);
  });
});
