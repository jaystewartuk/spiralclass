/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { gateAddStudent, gateAddTemplate } from "@/lib/subscriptions/enforce";
import { loadPlanUsage } from "@/lib/subscriptions/usage";
import { entitlementsFor } from "@/lib/subscriptions/entitlements";
import type { SubscriptionLike } from "@spiralclass/shared";

const FREE: NonNullable<SubscriptionLike> = {
  plan: "free",
  status: "free",
  comped: false,
  trialEndsAt: null,
  currentPeriodEnd: null,
};
const PRO: NonNullable<SubscriptionLike> = { ...FREE, plan: "monthly", status: "active" };

// A prisma stand-in that RECORDS the `where` it is counted with, which is the
// only thing worth asserting here: the fake in _fake-prisma.ts ignores `where`
// entirely, so a test built on it would pass just as happily if the panel and
// the gate counted different rows.
function recordingPrisma(counts: { students: number; templates: number }) {
  const seen: Record<string, unknown[]> = { teacherStudent: [], packageTemplate: [] };
  const db = {
    teacherSubscription: {
      async findUnique() {
        return FREE;
      },
    },
    teacherStudent: {
      async count({ where }: any) {
        seen.teacherStudent.push(where);
        return counts.students;
      },
    },
    packageTemplate: {
      async count({ where }: any) {
        seen.packageTemplate.push(where);
        return counts.templates;
      },
    },
  } as any;
  return { db, seen };
}

describe("loadPlanUsage", () => {
  // The invariant this module exists for. A "2 of 3" that disagreed with the
  // gate would tell a teacher she has room and then refuse her, with nothing
  // on screen to say which number lied.
  it("counts exactly the rows the gates count", async () => {
    const { db, seen } = recordingPrisma({ students: 2, templates: 1 });

    await loadPlanUsage("t1", entitlementsFor(FREE), db);
    await gateAddStudent("t1", db);
    await gateAddTemplate("t1", db);

    const [panelStudents, gateStudents] = seen.teacherStudent;
    const [panelTemplates, gateTemplates] = seen.packageTemplate;
    expect(panelStudents).toEqual(gateStudents);
    expect(panelTemplates).toEqual(gateTemplates);
    // ...and that the shared clause is still the intended definition of
    // "active", so the two agreeing on something wrong would still fail.
    expect(panelStudents).toEqual({ teacherId: "t1", archivedAt: null });
    expect(panelTemplates).toEqual({ teacherId: "t1", archived: false });
  });

  it("reports usage against the Free caps", async () => {
    const { db } = recordingPrisma({ students: 2, templates: 1 });
    const usage = await loadPlanUsage("t1", entitlementsFor(FREE), db);
    expect(usage.students).toEqual({ used: 2, limit: 3, overLimit: false });
    expect(usage.templates).toEqual({ used: 1, limit: 1, overLimit: false });
  });

  // Downgrading never deletes data, so over-cap is an ordinary state the panel
  // has to be able to render — not an impossible one to clamp away.
  it("reports a grandfathered teacher as over the limit rather than clamping", async () => {
    const { db } = recordingPrisma({ students: 7, templates: 4 });
    const usage = await loadPlanUsage("t1", entitlementsFor(FREE), db);
    expect(usage.students).toEqual({ used: 7, limit: 3, overLimit: true });
    expect(usage.templates.overLimit).toBe(true);
  });

  // Infinity does not survive serialization and renders as "of ∞"; null forces
  // the caller to handle unlimited as its own case.
  it("reports an unlimited grant as a null limit, never Infinity", async () => {
    const { db } = recordingPrisma({ students: 400, templates: 30 });
    const usage = await loadPlanUsage("t1", entitlementsFor(PRO), db);
    expect(usage.students).toEqual({ used: 400, limit: null, overLimit: false });
    expect(usage.templates).toEqual({ used: 30, limit: null, overLimit: false });
  });
});
