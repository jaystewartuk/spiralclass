import { describe, expect, it, vi } from "vitest";
import { mergeRosterStudents } from "@/lib/students/merge";

// Roster-merge guardrails (duplicate from a checkout-email typo). The refusal
// matrix is the security-relevant part: never merge across teachers, never
// merge two real logins, never touch a moderated or pending-deletion row. The
// happy path repoints everything and deletes the duplicate.

vi.mock("@/lib/audit", () => ({ writeOverride: vi.fn(async () => {}) }));

const T = "t1";
const KEEP = "keep";
const DUP = "dup";

type Student = {
  id: string;
  disabledAt: Date | null;
  authUserId: string | null;
  email: string | null;
  phoneE164: string | null;
  timezone: string | null;
  notificationPrefs: unknown;
};

function student(id: string, over: Partial<Student> = {}): Student {
  return {
    id,
    disabledAt: null,
    authUserId: null,
    email: `${id}@x.com`,
    phoneE164: null,
    timezone: null,
    notificationPrefs: null,
    ...over,
  };
}

function fakeDb(
  opts: {
    keep?: Student | null;
    dup?: Student | null;
    dupOtherTeacher?: boolean;
    pendingDeletion?: boolean;
    pendingDeletionIds?: string[];
    /** teacher overrides agreed prices sitting on the DUPLICATE's pairing. */
    dupPrices?: { templateId: string; priceMinorUnits: number; currency: string }[];
  } = {},
) {
  const keep = opts.keep === undefined ? student(KEEP) : opts.keep;
  const dup = opts.dup === undefined ? student(DUP) : opts.dup;
  const deleted: string[] = [];
  const tx = {
    studentLibraryItem: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
    studentNote: { updateMany: vi.fn(async () => ({ count: 1 })) },
    package: { updateMany: vi.fn(async () => ({ count: 1 })) },
    booking: { updateMany: vi.fn(async () => ({ count: 3 })) },
    webPushSubscription: { updateMany: vi.fn(async () => ({ count: 2 })) },
    notification: { updateMany: vi.fn(async () => ({ count: 5 })) },
    student: {
      update: vi.fn(async () => ({})),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        return {};
      }),
    },
    teacherStudent: { update: vi.fn(async () => ({})) },
    teacherStudentTemplatePrice: {
      findMany: vi.fn(async () => opts.dupPrices ?? []),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const db = {
    teacherStudent: {
      findUnique: vi.fn(
        async ({ where }: { where: { teacherId_studentId: { studentId: string } } }) => {
          const id = where.teacherId_studentId.studentId;
          if (id === KEEP)
            return keep
              ? {
                  student: keep,
                  levelId: null,
                  customPriceNote: null,
                  archivedAt: null,
                }
              : null;
          if (id === DUP)
            return dup
              ? {
                  student: dup,
                  levelId: null,
                  customPriceNote: null,
                  archivedAt: null,
                }
              : null;
          return null;
        },
      ),
      findFirst: vi.fn(async () => (opts.dupOtherTeacher ? { teacherId: "t2" } : null)),
    },
    accountDeletionRequest: {
      // Honors the subjectId `in` filter so keeper-vs-duplicate can be
      // distinguished. `pendingDeletion: true` = the duplicate; explicit ids
      // via `pendingDeletionIds` cover the keeper case.
      findFirst: vi.fn(async ({ where }: { where: { subjectId: { in: string[] } } }) => {
        const withPending = opts.pendingDeletionIds ?? (opts.pendingDeletion ? [DUP] : []);
        const ids = where.subjectId?.in ?? [];
        return ids.some((id) => withPending.includes(id)) ? { id: "d1" } : null;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { db: db as never, deleted, tx };
}

const input = { teacherId: T, keepStudentId: KEEP, mergeStudentId: DUP };

describe("mergeRosterStudents — refusals", () => {
  it("refuses when a row isn't on the roster", async () => {
    const { db } = fakeDb({ dup: null });
    expect(await mergeRosterStudents(input, db)).toEqual({ ok: false, code: "not_on_roster" });
  });

  it("refuses a moderated (disabled) row", async () => {
    const { db } = fakeDb({ dup: student(DUP, { disabledAt: new Date() }) });
    expect(await mergeRosterStudents(input, db)).toEqual({ ok: false, code: "disabled" });
  });

  it("refuses when both rows have distinct logins", async () => {
    const { db } = fakeDb({
      keep: student(KEEP, { authUserId: "uK" }),
      dup: student(DUP, { authUserId: "uD" }),
    });
    expect(await mergeRosterStudents(input, db)).toEqual({ ok: false, code: "two_logins" });
  });

  it("refuses when the duplicate belongs to another teacher", async () => {
    const { db } = fakeDb({ dupOtherTeacher: true });
    expect(await mergeRosterStudents(input, db)).toEqual({ ok: false, code: "other_teacher" });
  });

  it("refuses when the duplicate has a pending deletion request", async () => {
    const { db } = fakeDb({ pendingDeletion: true });
    expect(await mergeRosterStudents(input, db)).toEqual({ ok: false, code: "pending_deletion" });
  });

  it("refuses when the KEEPER has a pending deletion request", async () => {
    // Regression: only the duplicate was checked. If the keeper is scheduled
    // for anonymization, the merge would move the duplicate's live packages and
    // login onto a row about to be tombstoned.
    const { db, deleted } = fakeDb({ pendingDeletionIds: [KEEP] });
    expect(await mergeRosterStudents(input, db)).toEqual({ ok: false, code: "pending_deletion" });
    expect(deleted).toHaveLength(0);
  });
});

describe("mergeRosterStudents — happy path", () => {
  it("repoints everything, deletes the duplicate, and reports moved counts", async () => {
    const { db, deleted } = fakeDb();
    const res = await mergeRosterStudents(input, db);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.moved).toMatchObject({
        packages: 1,
        bookings: 3,
        libraryItems: 2,
        notifications: 5,
        // Regression: the merge moved a retired token table and never the
        // browser subscriptions, stranding them on a Student row deleted three
        // statements later — the student silently stopped receiving push.
        pushSubscriptions: 2,
      });
    }
    expect(deleted).toEqual([DUP]);
  });

  it("moves the login link when only the duplicate has one", async () => {
    const { db } = fakeDb({ dup: student(DUP, { authUserId: "uD" }) });
    const res = await mergeRosterStudents(input, db);
    expect(res.ok && res.moved.authUserMoved).toBe(true);
  });

  // Grandfathering: the duplicate's agreed prices follow the packages and
  // bookings onto the keeper, per package.
  it("moves the duplicate's agreed prices onto the keeper", async () => {
    const { db, tx } = fakeDb({
      dupPrices: [
        { templateId: "tpl-4", priceMinorUnits: 130_000, currency: "MXN" },
        { templateId: "tpl-20", priceMinorUnits: 600_000, currency: "MXN" },
      ],
    });
    expect((await mergeRosterStudents(input, db)).ok).toBe(true);

    const createMany = tx.teacherStudentTemplatePrice.createMany as ReturnType<typeof vi.fn>;
    expect(createMany).toHaveBeenCalledTimes(1);
    const arg = createMany.mock.calls[0][0] as {
      data: { studentId: string; templateId: string; priceMinorUnits: number }[];
      skipDuplicates: boolean;
    };
    expect(arg.data.map((r) => r.templateId).sort()).toEqual(["tpl-20", "tpl-4"]);
    expect(arg.data.every((r) => r.studentId === KEEP)).toBe(true);
    // The keeper's own agreed price wins — it is attached to the surviving
    // identity — so rows it already has are left alone rather than overwritten.
    expect(arg.skipDuplicates).toBe(true);
  });

  it("writes nothing when the duplicate has no agreed prices", async () => {
    const { db, tx } = fakeDb();
    expect((await mergeRosterStudents(input, db)).ok).toBe(true);
    expect(tx.teacherStudentTemplatePrice.createMany).not.toHaveBeenCalled();
  });

  it("returns code 'failed' when the transaction throws (RESTRICT FK)", async () => {
    const { db, tx } = fakeDb();
    (tx.student.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("FK restrict"));
    expect(await mergeRosterStudents(input, db)).toEqual({ ok: false, code: "failed" });
  });
});
