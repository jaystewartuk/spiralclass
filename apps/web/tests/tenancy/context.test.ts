import { describe, expect, it } from "vitest";

import {
  currentScope,
  describeScope,
  enterTeacherScope,
  runCrossTenant,
  runInTeacherScope,
} from "@/lib/tenancy/context";

const TEACHER_A = "a1111111-1111-4111-8111-111111111111";
const TEACHER_B = "b2222222-2222-4222-8222-222222222222";

describe("tenancy context", () => {
  it("carries a teacher scope across an await chain", async () => {
    // This is the assertion the whole design rests on. `requireTeacher` calls
    // `enterTeacherScope` and then RETURNS — the page that will query the
    // database has not run yet. If the scope failed to reach it, the guard
    // would report every query as unattributed, which is indistinguishable
    // from a clean tree. So propagation is proved, not assumed.
    await runInTeacherScope(TEACHER_A, async () => {
      expect(currentScope()).toEqual({ kind: "teacher", teacherId: TEACHER_A });
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(currentScope()).toEqual({ kind: "teacher", teacherId: TEACHER_A });
      await nested();
    });
  });

  async function nested() {
    await Promise.resolve();
    expect(currentScope()?.kind).toBe("teacher");
  }

  it("propagates a scope entered without a callback, the way a gate enters one", async () => {
    // `enterWith` is what an auth gate can actually use; `run` needs a callback
    // the gate does not have. Same guarantee, different entry point — asserted
    // separately because only one of them is on the real request path.
    await runInTeacherScope(TEACHER_A, async () => {
      enterTeacherScope(TEACHER_B);
      await Promise.resolve();
      expect(currentScope()).toEqual({ kind: "teacher", teacherId: TEACHER_B });
    });
  });

  it("keeps concurrent requests from seeing each other's tenant", async () => {
    // One Node process serves many teachers at once through one Prisma client
    // (lib/db-pool.ts sizes the pool for exactly that). A context that bled
    // between concurrent requests would be worse than no context at all.
    const seen: string[] = [];
    await Promise.all([
      runInTeacherScope(TEACHER_A, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(describeScope(currentScope()));
      }),
      runInTeacherScope(TEACHER_B, async () => {
        seen.push(describeScope(currentScope()));
      }),
    ]);
    expect(seen.sort()).toEqual([`teacher:${TEACHER_A}`, `teacher:${TEACHER_B}`]);
  });

  it("has no scope outside a gate, and says so rather than guessing", () => {
    expect(currentScope()).toBeUndefined();
    expect(describeScope(undefined)).toBe("unscoped");
  });

  it("carries the reason on a deliberate cross-tenant read", () => {
    runCrossTenant("admin console reads every tenant (D-25)", () => {
      expect(currentScope()).toEqual({
        kind: "cross-tenant",
        reason: "admin console reads every tenant (D-25)",
      });
    });
  });
});
