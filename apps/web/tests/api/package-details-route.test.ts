import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/packages/[id] — the viewer-scoped data source behind
// PackageDetailsSheet. Pins the access-control boundary: a teacher only ever
// resolves their OWN package (scoped by teacherId), a student only ever
// resolves a package that's actually theirs (scoped by studentIdentityIds),
// and price is never present in a student response.

const PACKAGE_ID = "44444444-4444-4444-8444-aaaaaaaaaaaa";
const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";

const packageRow = {
  id: PACKAGE_ID,
  teacherId: TEACHER_ID,
  studentId: STUDENT_ID,
  classesTotal: 8,
  classesUsed: 2,
  status: "active",
  purchasedAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: null,
  pricePaidMinorUnits: 200000,
  currency: "MXN",
  template: { name: "Conversación", subject: "Spanish" },
  teacher: { id: TEACHER_ID, name: "Beatriz" },
  student: { id: STUDENT_ID, name: "Marco" },
  bookings: [] as { id: string }[],
};

const state: {
  teacher: { id: string } | null;
  student: { id: string; email: string | null } | null;
} = {
  teacher: null,
  student: null,
};

vi.mock("@/lib/auth", () => ({
  getCurrentTeacher: async () => state.teacher,
  getCurrentStudent: async () => state.student,
}));

vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: async (s: { id: string }) => [s.id],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    package: {
      findFirst: async ({ where }: any) => {
        if (where.id !== PACKAGE_ID) return null;
        if (where.teacherId !== undefined && where.teacherId !== packageRow.teacherId) return null;
        if (
          where.studentId?.in !== undefined &&
          !where.studentId.in.includes(packageRow.studentId)
        ) {
          return null;
        }
        return packageRow;
      },
    },
  },
}));

const { GET } = await import("@/app/api/packages/[id]/route");

function req() {
  return new Request(`https://test.local/api/packages/${PACKAGE_ID}`);
}
function ctx(id: string = PACKAGE_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  state.teacher = null;
  state.student = null;
});

describe("GET /api/packages/[id]", () => {
  it("401s when signed out", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
  });

  it("returns price for the owning teacher", async () => {
    state.teacher = { id: TEACHER_ID };
    const res = await GET(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.price).toEqual({ amountMinorUnits: 200000, currency: "MXN" });
    expect(body.counterpart).toEqual({ id: STUDENT_ID, name: "Marco", role: "student" });
  });

  it("404s for a package belonging to a different teacher", async () => {
    state.teacher = { id: "some-other-teacher" };
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
  });

  it("returns no price for the owning student", async () => {
    state.student = { id: STUDENT_ID, email: "marco@example.com" };
    const res = await GET(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.price).toBeNull();
    expect(body.counterpart).toEqual({ id: TEACHER_ID, name: "Beatriz", role: "teacher" });
  });

  it("404s for a package belonging to a different student", async () => {
    state.student = { id: "some-other-student", email: "x@example.com" };
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
  });
});
