import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveLinkedStudent decides which Student row owns an auth user on sign-in.
// Rules under test:
//   * an already-linked row (authUserId match) always wins, no email needed;
//   * else the OLDEST unlinked rostered row with that email is linked;
//   * a concurrent first sign-in that loses the unique-constraint race
//     (P2002) re-reads and returns the winner's row;
//   * Teacher and Student are mutually exclusive per auth identity (D-38):
//     if this auth user already owns a Teacher row, refuse to link instead
//     of silently merging the two identities.

type StudentRow = {
  id: string;
  authUserId: string | null;
  email: string | null;
  createdAt: Date;
  rostered: boolean;
};

const state: { rows: StudentRow[]; updateError: unknown; teacherIds: string[] } = {
  rows: [],
  updateError: null,
  teacherIds: [],
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.teacherIds.includes(where.id) ? { id: where.id } : null,
      ),
    },
    student: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // Linked lookup: { authUserId: <id> }
        if (typeof where.authUserId === "string") {
          const hit = state.rows.find((r) => r.authUserId === where.authUserId);
          return hit ? { id: hit.id } : null;
        }
        // Email-match lookup: unlinked + rostered + case-insensitive email,
        // oldest first.
        const emailEq = (where.email as { equals: string }).equals.toLowerCase();
        const candidates = state.rows
          .filter(
            (r) => r.authUserId === null && r.rostered && (r.email ?? "").toLowerCase() === emailEq,
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const match = candidates[0];
        return match ? { id: match.id } : null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { authUserId: string } }) => {
          // Simulate a concurrent winner: the row gets linked to this auth
          // user even when our own write loses the unique-constraint race.
          const row = state.rows.find((r) => r.id === where.id);
          if (row) row.authUserId = data.authUserId;
          if (state.updateError) throw state.updateError;
          return { id: where.id };
        },
      ),
    },
  },
}));

const { resolveLinkedStudent, hasClaimableStudentRow } = await import("@/lib/auth/student-link");
const { Prisma } = await import("@prisma/client");

function row(p: Partial<StudentRow> & { id: string }): StudentRow {
  return {
    authUserId: null,
    email: "mira@example.com",
    createdAt: new Date("2026-01-01"),
    rostered: true,
    ...p,
  };
}

beforeEach(() => {
  state.rows = [];
  state.updateError = null;
  state.teacherIds = [];
});

describe("resolveLinkedStudent", () => {
  it("returns the already-linked row without needing an email", async () => {
    state.rows = [row({ id: "linked", authUserId: "u1", email: null })];
    expect(await resolveLinkedStudent({ id: "u1" })).toEqual({
      status: "linked",
      id: "linked",
      alreadyLinked: true,
    });
  });

  it("returns none when no email and nothing is linked", async () => {
    expect(await resolveLinkedStudent({ id: "u9" })).toEqual({ status: "none" });
  });

  it("links the oldest unlinked rostered row matching the email", async () => {
    state.rows = [
      row({ id: "newer", createdAt: new Date("2026-03-01") }),
      row({ id: "oldest", createdAt: new Date("2026-01-01") }),
    ];
    expect(await resolveLinkedStudent({ id: "u1", email: "mira@example.com" })).toEqual({
      status: "linked",
      id: "oldest",
      alreadyLinked: false,
    });
    expect(state.rows.find((r) => r.id === "oldest")?.authUserId).toBe("u1");
  });

  it("matches email case-insensitively", async () => {
    state.rows = [row({ id: "s1", email: "Mira@Example.com" })];
    expect(await resolveLinkedStudent({ id: "u1", email: "mira@example.com" })).toEqual({
      status: "linked",
      id: "s1",
      alreadyLinked: false,
    });
  });

  it("ignores rosterless orphan rows", async () => {
    state.rows = [row({ id: "orphan", rostered: false })];
    expect(await resolveLinkedStudent({ id: "u1", email: "mira@example.com" })).toEqual({
      status: "none",
    });
  });

  it("returns none when the email matches nobody", async () => {
    state.rows = [row({ id: "s1", email: "other@example.com" })];
    expect(await resolveLinkedStudent({ id: "u1", email: "mira@example.com" })).toEqual({
      status: "none",
    });
  });

  it("recovers from a P2002 race by re-reading the winner's row", async () => {
    state.rows = [row({ id: "contested" })];
    state.updateError = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    // The losing writer's update throws P2002; the winner has meanwhile
    // linked the row to this auth user, so the catch re-read finds it.
    expect(await resolveLinkedStudent({ id: "u1", email: "mira@example.com" })).toEqual({
      status: "linked",
      id: "contested",
      alreadyLinked: true,
    });
  });

  it("refuses to link when this auth identity already owns a Teacher row (D-38)", async () => {
    state.rows = [row({ id: "s1", email: "mira@example.com" })];
    state.teacherIds = ["u1"];
    expect(await resolveLinkedStudent({ id: "u1", email: "mira@example.com" })).toEqual({
      status: "conflict",
    });
    // The unlinked row must stay untouched — no silent merge.
    expect(state.rows.find((r) => r.id === "s1")?.authUserId).toBeNull();
  });
});

// The read-only probe the routing/provisioning guards use. It exists because
// those guards previously asked `authUserId: user.id`, which is null for a
// student whose first-ever sign-in is the magic link from her own purchase —
// so they concluded "not a student", offered her the teacher dashboard, and
// lazily provisioned her AS a teacher. That Teacher row then made her
// permanently unclaimable as a student (resolveLinkedStudent → conflict).
describe("hasClaimableStudentRow", () => {
  it("is true for an UNLINKED rostered row — the case that caused the incident", async () => {
    state.rows = [row({ id: "s1", authUserId: null, email: "sol@example.com" })];
    expect(await hasClaimableStudentRow({ id: "u1", email: "sol@example.com" })).toBe(true);
  });

  it("is true for an already-linked row", async () => {
    state.rows = [row({ id: "s1", authUserId: "u1" })];
    expect(await hasClaimableStudentRow({ id: "u1", email: null })).toBe(true);
  });

  it("matches email case-insensitively, like the resolver", async () => {
    state.rows = [row({ id: "s1", email: "Sol@Example.com" })];
    expect(await hasClaimableStudentRow({ id: "u1", email: "sol@example.com" })).toBe(true);
  });

  it("is false for a genuine new teacher — nobody has her on a roster", async () => {
    // The safety property behind refusing to provision: a real teacher signing
    // up for the first time has no roster row carrying her email, so this
    // cannot lock her out of her own dashboard.
    state.rows = [row({ id: "s1", email: "someone-else@example.com" })];
    expect(await hasClaimableStudentRow({ id: "u1", email: "newteacher@example.com" })).toBe(false);
  });

  it("ignores rosterless orphan rows", async () => {
    state.rows = [row({ id: "s1", rostered: false, email: "sol@example.com" })];
    expect(await hasClaimableStudentRow({ id: "u1", email: "sol@example.com" })).toBe(false);
  });

  it("is false with no email and nothing linked", async () => {
    state.rows = [row({ id: "s1", email: "sol@example.com" })];
    expect(await hasClaimableStudentRow({ id: "u1", email: null })).toBe(false);
  });

  it("never mutates — a guard must not claim a row as a side effect", async () => {
    state.rows = [row({ id: "s1", authUserId: null, email: "sol@example.com" })];
    await hasClaimableStudentRow({ id: "u1", email: "sol@example.com" });
    expect(state.rows.find((r) => r.id === "s1")?.authUserId).toBeNull();
  });
});
