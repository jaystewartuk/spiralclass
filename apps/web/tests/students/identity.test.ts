import { beforeEach, describe, expect, it, vi } from "vitest";

// Portal identity aggregation (src/lib/students/identity.ts) — the signed-in
// inbox owns every Student row carrying its email, so the portal reads and
// acts across all of them. Asserts the helper: linked row first,
// case-insensitive sibling match, moderated siblings excluded, no-email →
// linked row only.
//
// It also used to assert the aggregation end to end, by calling a portal
// route and checking the response carried a sibling teacher's packages
// and bookings — the headline "I can't see my classes with my other teacher"
// fix. That block went with the route. Stated rather than quietly
// dropped: what is lost is a route-level check that a caller really passes the
// whole identity set, and 43 call sites now use `studentIdentityIds`,
// `(student)/my-classes/page.tsx` among them.

const AUTH_USER_ID = "33333333-3333-4333-8333-333333333333";
const LINKED_ID = "22222222-2222-4222-8222-222222222222";
const SIBLING_ID = "22222222-2222-4222-8222-cccccccccccc";
const DISABLED_SIBLING_ID = "22222222-2222-4222-8222-eeeeeeeeeeee";
const STRANGER_ID = "22222222-2222-4222-8222-dddddddddddd";
const TEACHER_A = "11111111-1111-4111-8111-111111111111";
const TEACHER_B = "11111111-1111-4111-8111-bbbbbbbbbbbb";

type StudentRow = {
  id: string;
  authUserId: string | null;
  email: string | null;
  name: string;
  locale: string;
  timezone: string | null;
  disabledAt: Date | null;
};
type PackageRow = {
  id: string;
  studentId: string;
  teacherId: string;
  classesTotal: number;
  classesUsed: number;
  expiresAt: Date | null;
  status: string;
};
type BookingRow = {
  id: string;
  studentId: string;
  teacherId: string;
  packageId: string;
  status: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  rescheduleCount: number;
  rescheduledFromId: string | null;
};

const state: { students: StudentRow[]; packages: PackageRow[]; bookings: BookingRow[] } = {
  students: [],
  packages: [],
  bookings: [],
};

const FUTURE = new Date(Date.now() + 7 * 24 * 3600_000);
const PAST = new Date(Date.now() - 7 * 24 * 3600_000);

function freshState() {
  state.students = [
    {
      id: LINKED_ID,
      authUserId: AUTH_USER_ID,
      email: "marco@example.com",
      name: "Marco",
      locale: "es-MX",
      timezone: null,
      disabledAt: null,
    },
    // Same inbox, enrolled by a second teacher — only the oldest row links.
    {
      id: SIBLING_ID,
      authUserId: null,
      email: "MARCO@example.com", // legacy casing — match must be insensitive
      name: "Marco",
      locale: "es-MX",
      timezone: null,
      disabledAt: null,
    },
    // Same inbox but platform-moderated: stays invisible to the identity.
    {
      id: DISABLED_SIBLING_ID,
      authUserId: null,
      email: "marco@example.com",
      name: "Marco",
      locale: "es-MX",
      timezone: null,
      disabledAt: new Date(),
    },
    {
      id: STRANGER_ID,
      authUserId: null,
      email: "lucia@example.com",
      name: "Lucía",
      locale: "es-MX",
      timezone: null,
      disabledAt: null,
    },
  ];
  state.packages = [
    {
      id: "44444444-4444-4444-8444-aaaaaaaaaaaa",
      studentId: LINKED_ID,
      teacherId: TEACHER_A,
      classesTotal: 8,
      classesUsed: 2,
      expiresAt: FUTURE,
      status: "active",
    },
    {
      id: "44444444-4444-4444-8444-bbbbbbbbbbbb",
      studentId: SIBLING_ID,
      teacherId: TEACHER_B,
      classesTotal: 4,
      classesUsed: 1,
      expiresAt: FUTURE,
      status: "active",
    },
    {
      id: "44444444-4444-4444-8444-cccccccccccc",
      studentId: STRANGER_ID,
      teacherId: TEACHER_A,
      classesTotal: 8,
      classesUsed: 0,
      expiresAt: FUTURE,
      status: "active",
    },
  ];
  state.bookings = [
    {
      id: "55555555-5555-4555-8555-aaaaaaaaaaaa",
      studentId: LINKED_ID,
      teacherId: TEACHER_A,
      packageId: "44444444-4444-4444-8444-aaaaaaaaaaaa",
      status: "scheduled",
      scheduledStart: FUTURE,
      scheduledEnd: new Date(FUTURE.getTime() + 50 * 60_000),
      rescheduleCount: 0,
      rescheduledFromId: null,
    },
    // The sibling row's class with the other teacher — previously invisible.
    {
      id: "55555555-5555-4555-8555-bbbbbbbbbbbb",
      studentId: SIBLING_ID,
      teacherId: TEACHER_B,
      packageId: "44444444-4444-4444-8444-bbbbbbbbbbbb",
      status: "scheduled",
      scheduledStart: new Date(FUTURE.getTime() + 24 * 3600_000),
      scheduledEnd: new Date(FUTURE.getTime() + 24 * 3600_000 + 50 * 60_000),
      rescheduleCount: 0,
      rescheduledFromId: null,
    },
    {
      id: "55555555-5555-4555-8555-cccccccccccc",
      studentId: STRANGER_ID,
      teacherId: TEACHER_A,
      packageId: "44444444-4444-4444-8444-cccccccccccc",
      status: "scheduled",
      scheduledStart: PAST,
      scheduledEnd: new Date(PAST.getTime() + 50 * 60_000),
      rescheduleCount: 0,
      rescheduledFromId: null,
    },
  ];
}

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ NODE_ENV: "test" }),
  isSuperuser: () => false,
}));

vi.mock("@/lib/prisma", () => {
  function idMatches(value: string, cond: any): boolean {
    if (typeof cond === "object" && cond !== null) {
      if (cond.in) return cond.in.includes(value);
      if (cond.not) return value !== cond.not;
    }
    return value === cond;
  }
  function emailMatches(value: string | null, cond: any): boolean {
    const want = typeof cond === "object" && cond !== null ? cond.equals : cond;
    if (value === null || want === null) return value === want;
    if (typeof cond === "object" && cond?.mode === "insensitive") {
      return value.toLowerCase() === String(want).toLowerCase();
    }
    return value === want;
  }
  function studentWhere(s: StudentRow, where: any): boolean {
    if (where.id !== undefined && !idMatches(s.id, where.id)) return false;
    if (where.authUserId !== undefined && s.authUserId !== where.authUserId) return false;
    if (where.email !== undefined && !emailMatches(s.email, where.email)) return false;
    if (where.disabledAt !== undefined && s.disabledAt !== where.disabledAt) return false;
    return true;
  }
  return {
    prisma: {
      student: {
        findMany: async ({ where }: any) =>
          state.students.filter((s) => studentWhere(s, where)).map((s) => ({ id: s.id })),
        findFirst: async ({ where }: any) =>
          state.students.find((s) => studentWhere(s, where)) ?? null,
      },
      // The portal route reads per-teacher levels for the "your level" line;
      // aggregation tests don't exercise levels, so an empty set suffices.
      teacherStudent: { findMany: async () => [] },
      package: {
        findMany: async ({ where }: any) =>
          state.packages
            .filter((p) => idMatches(p.studentId, where.studentId))
            .map((p) => ({ ...p, template: { name: "Plan" }, teacher: { name: "Teacher" } })),
      },
      booking: {
        findMany: async ({ where }: any) =>
          state.bookings
            .filter((b) => {
              if (!idMatches(b.studentId, where.studentId)) return false;
              if (where.status && b.status !== where.status) return false;
              if (where.scheduledStart?.gte && b.scheduledStart < where.scheduledStart.gte)
                return false;
              if (where.scheduledStart?.lt && b.scheduledStart >= where.scheduledStart.lt)
                return false;
              return true;
            })
            .map((b) => ({
              ...b,
              student: { id: b.studentId, name: "Marco" },
              teacher: { id: b.teacherId, name: "Teacher" },
              package: {
                id: b.packageId,
                classDurationMin: 50,
                expiresAt: FUTURE,
                template: { name: "Plan" },
              },
            })),
      },
    },
  };
});

const { purchasingLinkFor, studentIdentityIds } = await import("@/lib/students/identity");

beforeEach(() => {
  freshState();
});

describe("studentIdentityIds", () => {
  it("returns the linked row first plus same-inbox siblings, case-insensitively", async () => {
    const ids = await studentIdentityIds({ id: LINKED_ID, email: "marco@example.com" });
    expect(ids[0]).toBe(LINKED_ID);
    expect(ids).toContain(SIBLING_ID);
    expect(ids).not.toContain(STRANGER_ID);
  });

  it("excludes moderated siblings — a disabled row can't be reached through the linked login", async () => {
    const ids = await studentIdentityIds({ id: LINKED_ID, email: "marco@example.com" });
    expect(ids).not.toContain(DISABLED_SIBLING_ID);
  });

  it("falls back to the linked row alone when it has no email", async () => {
    const ids = await studentIdentityIds({ id: LINKED_ID, email: null });
    expect(ids).toEqual([LINKED_ID]);
  });
});

// The one resolver every pricing and charging surface shares. It exists
// because the portal used to price a package from the whole identity set
// while checkout charged through a single pairing row: a teacher set an
// agreed price, the buy page rendered it as "tu precio acordado", and the
// student was charged the catalog price.
describe("purchasingLinkFor", () => {
  type Where = { teacherId: string; studentId: { in: string[] }; archivedAt: null };
  const rows = [
    { teacherId: TEACHER_A, studentId: SIBLING_ID, archivedAt: null, createdAt: new Date(2) },
    { teacherId: TEACHER_A, studentId: LINKED_ID, archivedAt: new Date(), createdAt: new Date(1) },
    { teacherId: TEACHER_B, studentId: LINKED_ID, archivedAt: null, createdAt: new Date(3) },
  ];
  // Applies the filters and the ordering Prisma would, so these assert the
  // resolver's query rather than a stub that ignores it.
  const findFirst = vi.fn(async ({ where }: { where: Where }) => {
    const matches = rows
      .filter(
        (r) =>
          r.teacherId === where.teacherId &&
          where.studentId.in.includes(r.studentId) &&
          r.archivedAt === null,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matches[0] ? { studentId: matches[0].studentId } : null;
  });
  const db = { teacherStudent: { findFirst } } as unknown as Parameters<
    typeof purchasingLinkFor
  >[2];

  it("resolves the pairing row across the identity set, not just the linked row", async () => {
    expect((await purchasingLinkFor(TEACHER_B, [LINKED_ID, SIBLING_ID], db))?.studentId).toBe(
      LINKED_ID,
    );
  });

  it("skips an archived pairing rather than refusing the sale outright", async () => {
    // The OLDER pairing with TEACHER_A is archived. Taking the oldest row of
    // any state and then rejecting it — what the checkout action used to do —
    // blocked a student whose live pairing the portal was busy offering.
    expect((await purchasingLinkFor(TEACHER_A, [LINKED_ID, SIBLING_ID], db))?.studentId).toBe(
      SIBLING_ID,
    );
  });

  it("returns null when every pairing with this teacher is archived", async () => {
    expect(await purchasingLinkFor(TEACHER_A, [LINKED_ID], db)).toBeNull();
  });

  it("returns null for a teacher this identity has no pairing with", async () => {
    expect(await purchasingLinkFor(STRANGER_ID, [LINKED_ID], db)).toBeNull();
  });

  it("short-circuits without querying when the identity set is empty", async () => {
    findFirst.mockClear();
    expect(await purchasingLinkFor(TEACHER_A, [], db)).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
