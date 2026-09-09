import { beforeEach, describe, expect, it, vi } from "vitest";

// Calendar feed tokens are per-user random secrets with a role prefix so the
// feed route knows which table to read without a double lookup. Pin: the
// role-prefix parsing (no DB), get-or-create reuse vs. mint, the unique-
// violation retry loop, and owner resolution.

type Row = { calendarFeedToken: string | null };
const state = {
  teacher: null as Row | null,
  student: null as Row | null,
  ownerTeacherId: null as string | null,
  ownerStudentId: null as string | null,
  failUpdatesBeforeSuccess: 0,
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: {
      findUnique: vi.fn(
        async ({ where }: { where: { calendarFeedToken?: string; id?: string } }) => {
          if (where.calendarFeedToken !== undefined) {
            return state.ownerTeacherId ? { id: state.ownerTeacherId } : null;
          }
          return state.teacher;
        },
      ),
      update: vi.fn(async () => {
        if (state.failUpdatesBeforeSuccess > 0) {
          state.failUpdatesBeforeSuccess -= 1;
          throw Object.assign(
            new (await import("@prisma/client")).Prisma.PrismaClientKnownRequestError("dup", {
              code: "P2002",
              clientVersion: "test",
            }),
          );
        }
        return {};
      }),
    },
    student: {
      findUnique: vi.fn(
        async ({ where }: { where: { calendarFeedToken?: string; id?: string } }) => {
          if (where.calendarFeedToken !== undefined) {
            return state.ownerStudentId ? { id: state.ownerStudentId } : null;
          }
          return state.student;
        },
      ),
      update: vi.fn(async () => ({})),
    },
  },
}));

const { feedTokenRole, getOrCreateTeacherFeedToken, rotateTeacherFeedToken, resolveFeedOwner } =
  await import("@/lib/calendar/feed-token");

beforeEach(() => {
  state.teacher = null;
  state.student = null;
  state.ownerTeacherId = null;
  state.ownerStudentId = null;
  state.failUpdatesBeforeSuccess = 0;
});

describe("feedTokenRole", () => {
  it("parses the role from the prefix without touching the DB", () => {
    expect(feedTokenRole("tch_abc")).toBe("teacher");
    expect(feedTokenRole("stu_abc")).toBe("student");
    expect(feedTokenRole("xxx_abc")).toBeNull();
  });
});

describe("getOrCreateTeacherFeedToken", () => {
  it("returns the existing token when present", async () => {
    state.teacher = { calendarFeedToken: "tch_existing" };
    expect(await getOrCreateTeacherFeedToken("t1")).toBe("tch_existing");
  });

  it("mints a new prefixed token when absent", async () => {
    state.teacher = { calendarFeedToken: null };
    const token = await getOrCreateTeacherFeedToken("t1");
    expect(token.startsWith("tch_")).toBe(true);
  });
});

describe("rotateTeacherFeedToken", () => {
  it("retries past a unique-violation and still returns a token", async () => {
    state.failUpdatesBeforeSuccess = 2;
    const token = await rotateTeacherFeedToken("t1");
    expect(token.startsWith("tch_")).toBe(true);
  });
});

describe("resolveFeedOwner", () => {
  it("resolves a teacher token to its owner", async () => {
    state.ownerTeacherId = "t9";
    expect(await resolveFeedOwner("tch_xyz")).toEqual({ kind: "teacher", id: "t9" });
  });

  it("resolves a student token to its owner", async () => {
    state.ownerStudentId = "s9";
    expect(await resolveFeedOwner("stu_xyz")).toEqual({ kind: "student", id: "s9" });
  });

  it("returns null for an unknown token or a malformed prefix", async () => {
    expect(await resolveFeedOwner("tch_missing")).toBeNull();
    expect(await resolveFeedOwner("bogus")).toBeNull();
  });
});
