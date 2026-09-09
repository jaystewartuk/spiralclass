import { beforeEach, describe, expect, it, vi } from "vitest";

// Homework / refunds magic-link redeem (D-40) — `/r/ml/<notificationId>` resolves
// the notification, mints a real better-auth session for the resolved
// student server-side (lib/auth/server-otp.ts's mintServerSideOtpSession —
// no email round trip), and 302s straight to `/my-classes` with the session
// cookie already set. Single-use semantics: the planted OTP is consumed
// immediately in the same request — a second click mints and consumes a
// fresh one.
//
// Asserts the four meaningful branches:
//   - happy path → 302 to /my-classes, session minted for the right email
//   - missing / wrong-template / wrong-recipient-type notification → 404 HTML
// - student not joined to the teacher (tenant isolation) → 404 HTML
//   - mintServerSideOtpSession throws → 503

const APP_URL = "https://app.test";

type NotifRow = {
  id: string;
  teacherId: string;
  recipientId: string;
  recipientType: "student" | "teacher";
  templateName: string;
};
type StudentRow = {
  id: string;
  email: string | null;
  // teacher_id we're joined to (for the teacherStudents.some filter).
  joinedTeacherIds: string[];
};

const state: {
  notifications: NotifRow[];
  students: StudentRow[];
  mintThrows: boolean;
  mintCalls: Array<{ email: string }>;
} = {
  notifications: [],
  students: [],
  mintThrows: false,
  mintCalls: [],
};

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL }),
}));

vi.mock("@/lib/auth/server-otp", () => ({
  mintServerSideOtpSession: async (email: string) => {
    state.mintCalls.push({ email });
    if (state.mintThrows) throw new Error("mint failed");
    return { token: "session-token", user: { id: "u-1", email } };
  },
}));

vi.mock("@/lib/prisma", () => {
  function notificationFindFirst({ where }: any) {
    for (const n of state.notifications) {
      if (where.id && n.id !== where.id) continue;
      if (where.templateName && n.templateName !== where.templateName) continue;
      return { ...n };
    }
    return null;
  }
  function studentFindFirst({ where }: any) {
    for (const s of state.students) {
      if (where.id && s.id !== where.id) continue;
      if (where.teacherStudents?.some?.teacherId) {
        if (!s.joinedTeacherIds.includes(where.teacherStudents.some.teacherId)) continue;
      }
      return { ...s };
    }
    return null;
  }
  return {
    prisma: {
      notification: { findFirst: notificationFindFirst },
      student: { findFirst: studentFindFirst },
    },
  };
});

const { GET } = await import("@/app/r/ml/[notificationId]/route");

function makeReq(notificationId: string) {
  return [
    new Request(`${APP_URL}/r/ml/${notificationId}`) as any,
    { params: Promise.resolve({ notificationId }) },
  ] as const;
}

beforeEach(() => {
  state.notifications = [
    {
      id: "notif-1",
      teacherId: "t-1",
      recipientId: "s-1",
      recipientType: "student",
      templateName: "magic_link",
    },
  ];
  state.students = [
    {
      id: "s-1",
      email: "alumno@example.com",
      joinedTeacherIds: ["t-1"],
    },
  ];
  state.mintThrows = false;
  state.mintCalls.length = 0;
});

describe("GET /r/ml/[notificationId] — happy path", () => {
  it("302s to /my-classes after minting a session for the resolved student", async () => {
    const [req, ctx] = makeReq("notif-1");
    const res = await GET(req, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/my-classes`);
    expect(state.mintCalls).toEqual([{ email: "alumno@example.com" }]);
  });

  it("mints (and consumes) a fresh session on each click — single-use semantics", async () => {
    const [req1, ctx1] = makeReq("notif-1");
    await GET(req1, ctx1);
    const [req2, ctx2] = makeReq("notif-1");
    const res = await GET(req2, ctx2);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/my-classes`);
    expect(state.mintCalls).toHaveLength(2);
  });
});

describe("GET /r/ml/[notificationId] — 404 paths", () => {
  it("404s when the notification id doesn't exist", async () => {
    const [req, ctx] = makeReq("missing-id");
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(state.mintCalls).toHaveLength(0);
  });

  it("404s when the notification has the wrong template name (defense-in-depth)", async () => {
    state.notifications[0].templateName = "booking_confirmation";
    const [req, ctx] = makeReq("notif-1");
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
  });

  it("404s when the notification's recipient is a teacher, not a student", async () => {
    state.notifications[0].recipientType = "teacher";
    const [req, ctx] = makeReq("notif-1");
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
  });

  it("tenant isolation: 404s when the student isn't linked to the notification's teacher", async () => {
    state.students[0].joinedTeacherIds = ["t-OTHER"];
    const [req, ctx] = makeReq("notif-1");
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
  });

  it("404s when the student row has no email (no destination for the session)", async () => {
    state.students[0].email = null;
    const [req, ctx] = makeReq("notif-1");
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
  });
});

describe("GET /r/ml/[notificationId] — 503 path", () => {
  it("503s when mintServerSideOtpSession throws", async () => {
    state.mintThrows = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [req, ctx] = makeReq("notif-1");
    const res = await GET(req, ctx);
    expect(res.status).toBe(503);
    errSpy.mockRestore();
  });
});
