import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyEmailOptOut } from "@/lib/email/opt-out-handler";
import { signEmailOptOutToken } from "@/lib/email/opt-out-token";

// Rate limiting email unsubscribe, identity-set aware: the footer click comes from
// the INBOX, so it must silence every same-email Student row — including a
// multi-teacher sibling under another teacher — not just the row the token
// was minted for.

const SECRET = "test-secret-of-sufficient-length-for-hmac";
const STUDENT_ID = "11111111-1111-4111-8111-111111111111";
const SIBLING_ID = "22222222-2222-4222-8222-222222222222";
const UNRELATED_ID = "33333333-3333-4333-8333-333333333333";
const TEACHER_ID = "44444444-4444-4444-8444-444444444444";

type StudentRow = {
  id: string;
  email: string | null;
  emailOptIn: boolean;
};

type FakeState = {
  students: Map<string, StudentRow>;
  memberships: Set<string>; // `${teacherId}:${studentId}`
};

function freshState(overrides?: {
  emailOptIn?: boolean;
  missingMembership?: boolean;
  email?: string | null;
}) {
  const email = overrides?.email !== undefined ? overrides.email : "mira@gmail.com";
  const state: FakeState = {
    students: new Map([
      [STUDENT_ID, { id: STUDENT_ID, email, emailOptIn: overrides?.emailOptIn ?? true }],
      // Same inbox, different teacher's roster row (and a different CASE,
      // exercising the insensitive match against legacy rows).
      [SIBLING_ID, { id: SIBLING_ID, email: "Mira@Gmail.com", emailOptIn: true }],
      [UNRELATED_ID, { id: UNRELATED_ID, email: "carlos@gmail.com", emailOptIn: true }],
    ]),
    memberships: new Set(),
  };
  if (!overrides?.missingMembership) {
    state.memberships.add(`${TEACHER_ID}:${STUDENT_ID}`);
  }
  return state;
}

function buildPrisma(state: FakeState) {
  return {
    teacherStudent: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = `${where.teacherId_studentId.teacherId}:${where.teacherId_studentId.studentId}`;
        return state.memberships.has(key)
          ? { teacherId: where.teacherId_studentId.teacherId }
          : null;
      }),
    },
    student: {
      findUnique: vi.fn(async ({ where }: any) => state.students.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const s = state.students.get(where.id);
        if (!s) throw new Error("missing student");
        Object.assign(s, data);
        return s;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const s of state.students.values()) {
          if (s.id === where.id?.not) continue;
          if (
            s.email != null &&
            where.email?.equals != null &&
            s.email.toLowerCase() === where.email.equals.toLowerCase()
          ) {
            Object.assign(s, data);
            count++;
          }
        }
        return { count };
      }),
    },
  } as any;
}

function token(now = new Date()) {
  return signEmailOptOutToken({ studentId: STUDENT_ID, teacherId: TEACHER_ID }, SECRET, now);
}

describe("applyEmailOptOut", () => {
  let state: FakeState;

  beforeEach(() => {
    state = freshState();
  });

  it("flips email_opt_in to false on the target AND same-email siblings", async () => {
    const outcome = await applyEmailOptOut({ prisma: buildPrisma(state), secret: SECRET }, token());
    expect(outcome).toEqual({
      code: "ok",
      idempotent: false,
      studentId: STUDENT_ID,
      teacherId: TEACHER_ID,
    });
    expect(state.students.get(STUDENT_ID)!.emailOptIn).toBe(false);
    expect(state.students.get(SIBLING_ID)!.emailOptIn).toBe(false);
    expect(state.students.get(UNRELATED_ID)!.emailOptIn).toBe(true);
  });

  it("is idempotent on a second click", async () => {
    const deps = { prisma: buildPrisma(state), secret: SECRET };
    await applyEmailOptOut(deps, token());
    const second = await applyEmailOptOut(deps, token());
    expect(second).toMatchObject({ code: "ok", idempotent: true });
  });

  it("only touches the target row when it has no email", async () => {
    state = freshState({ email: null });
    const outcome = await applyEmailOptOut({ prisma: buildPrisma(state), secret: SECRET }, token());
    expect(outcome).toMatchObject({ code: "ok" });
    expect(state.students.get(STUDENT_ID)!.emailOptIn).toBe(false);
    expect(state.students.get(SIBLING_ID)!.emailOptIn).toBe(true);
  });

  it("rejects a tampered token without touching any row", async () => {
    const outcome = await applyEmailOptOut(
      { prisma: buildPrisma(state), secret: SECRET },
      token() + "x",
    );
    expect(outcome.code).toBe("invalid-token");
    expect(state.students.get(STUDENT_ID)!.emailOptIn).toBe(true);
  });

  it("returns not-found when the (teacher, student) link is gone", async () => {
    state = freshState({ missingMembership: true });
    const outcome = await applyEmailOptOut({ prisma: buildPrisma(state), secret: SECRET }, token());
    expect(outcome).toEqual({ code: "not-found" });
    expect(state.students.get(STUDENT_ID)!.emailOptIn).toBe(true);
  });
});
