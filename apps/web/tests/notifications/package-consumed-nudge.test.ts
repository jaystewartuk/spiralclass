import { beforeEach, describe, expect, it, vi } from "vitest";

// The consumed-package renewal sweep must:
//   * skip archived ("dar de baja") pairings,
//   * stay silent while the pairing has another package that can still
//     absorb bookings (an active package with unused, unexpired capacity, or
//     a pending checkout) — regardless of purchase order, since
//     credit-ledger.ts drains the soonest-to-expire credit first, not the
//     newest one,
//   * nudge each package at most once (dedup via prior notification rows),
//   * and still write the teacher heads-up when the student turned the
//     category off — the teacher row anchors dedup for both variants.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_A = "22222222-2222-4222-8222-22222222222a";
const STUDENT_B = "22222222-2222-4222-8222-22222222222b";
const STUDENT_C = "22222222-2222-4222-8222-22222222222c";
const PKG_A = "33333333-3333-4333-8333-33333333333a";
const PKG_B = "33333333-3333-4333-8333-33333333333b";
const PKG_B_RENEWAL = "33333333-3333-4333-8333-33333333333c";
const PKG_C = "33333333-3333-4333-8333-33333333333d";
const PKG_C_OLDER_WITH_BALANCE = "33333333-3333-4333-8333-33333333333e";

const enqueueStudentMock = vi.fn(async (..._args: unknown[]) => "student-notif-id");
const enqueueTeacherMock = vi.fn(async (..._args: unknown[]) => "teacher-notif-id");
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueuePackageConsumedStudent: (...args: unknown[]) => enqueueStudentMock(...args),
  enqueuePackageConsumedTeacher: (...args: unknown[]) => enqueueTeacherMock(...args),
}));

// Avoid pulling the Inngest client (and its server-env validation) in via the
// transitive `./events` import — the sweep takes `emit` via deps anyway.
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: vi.fn(async () => {}),
}));

const { sendPackageConsumedNudges } = await import("@/lib/notifications/package-consumed-nudge");

type Candidate = {
  id: string;
  teacherId: string;
  studentId: string;
  student: { notificationPrefs: unknown };
};

type Sibling = {
  id: string;
  teacherId: string;
  studentId: string;
  status: "active" | "pending";
  classesUsed: number;
  classesTotal: number;
  expiresAt: Date | null;
};

function buildPrisma(opts: {
  candidates: Candidate[];
  siblings?: Sibling[];
  archived?: { teacherId: string; studentId: string }[];
  priorNudgedPackageIds?: string[];
}) {
  return {
    package: {
      // The sweep's where clause references this for the column-to-column
      // classesUsed >= classesTotal comparison; the mock only needs the
      // property to exist.
      fields: { classesTotal: {} },
      findMany: async ({ where }: any) => {
        // Candidates query pins status to the literal "active"; the sibling
        // scan uses `status: { in: [...] }`.
        if (where.status === "active") return opts.candidates;
        return opts.siblings ?? [];
      },
    },
    teacherStudent: {
      findMany: async ({ where }: any) => {
        const teacherIds: string[] = where.teacherId.in;
        const studentIds: string[] = where.studentId.in;
        return (opts.archived ?? []).filter(
          (l) => teacherIds.includes(l.teacherId) && studentIds.includes(l.studentId),
        );
      },
    },
    notification: {
      findMany: async () =>
        (opts.priorNudgedPackageIds ?? []).map((packageId) => ({
          metadata: { packageId },
        })),
    },
  } as any;
}

const emit = vi.fn(async () => {});

function candidate(overrides: Partial<Candidate> & { id: string; studentId: string }): Candidate {
  return {
    teacherId: TEACHER_ID,
    student: { notificationPrefs: null },
    ...overrides,
  };
}

beforeEach(() => {
  enqueueStudentMock.mockClear();
  enqueueTeacherMock.mockClear();
  emit.mockClear();
});

describe("sendPackageConsumedNudges", () => {
  it("nudges student and teacher for a fully used package with no sibling", async () => {
    const prisma = buildPrisma({
      candidates: [candidate({ id: PKG_A, studentId: STUDENT_A })],
    });

    const result = await sendPackageConsumedNudges({ prisma, emit });

    expect(result.sent).toBe(1);
    expect(enqueueTeacherMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        studentId: STUDENT_A,
        packageId: PKG_A,
        studentNotified: true,
      }),
    );
    expect(enqueueStudentMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ studentId: STUDENT_A, packageId: PKG_A }),
    );
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("skips a package whose pairing already has a renewal (a newer active/pending package)", async () => {
    const prisma = buildPrisma({
      candidates: [
        candidate({ id: PKG_A, studentId: STUDENT_A }),
        candidate({ id: PKG_B, studentId: STUDENT_B }),
      ],
      siblings: [
        // STUDENT_B already renewed: a fresh package on the same pairing,
        // still with untouched capacity.
        {
          id: PKG_B_RENEWAL,
          teacherId: TEACHER_ID,
          studentId: STUDENT_B,
          status: "active",
          classesUsed: 0,
          classesTotal: 4,
          expiresAt: null,
        },
        // The candidate itself also matches the sibling scan — it must not
        // suppress itself.
        {
          id: PKG_A,
          teacherId: TEACHER_ID,
          studentId: STUDENT_A,
          status: "active",
          classesUsed: 4,
          classesTotal: 4,
          expiresAt: null,
        },
      ],
    });

    const result = await sendPackageConsumedNudges({ prisma, emit });

    expect(result.sent).toBe(1);
    expect(enqueueTeacherMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ packageId: PKG_A }),
    );
    expect(enqueueTeacherMock).not.toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ packageId: PKG_B }),
    );
  });

  // Regression: a student with two concurrent packages (a small top-up plus
  // an ongoing bigger package) drained the small one first — credit-ledger.ts
  // prefers the soonest-to-expire credit, not the most recently purchased
  // one — while the bigger, earlier-purchased package still had classes
  // left. The nudge must not fire just because no *newer* package exists.
  it("skips a depleted package while an earlier-purchased sibling still has capacity", async () => {
    const prisma = buildPrisma({
      candidates: [candidate({ id: PKG_C, studentId: STUDENT_C })],
      siblings: [
        {
          id: PKG_C_OLDER_WITH_BALANCE,
          teacherId: TEACHER_ID,
          studentId: STUDENT_C,
          status: "active",
          classesUsed: 6,
          classesTotal: 8,
          expiresAt: new Date("2026-12-27T00:00:00Z"),
        },
      ],
    });

    const result = await sendPackageConsumedNudges({ prisma, emit });

    expect(result.sent).toBe(0);
    expect(enqueueTeacherMock).not.toHaveBeenCalled();
    expect(enqueueStudentMock).not.toHaveBeenCalled();
  });

  it("does not treat an expired sibling as available capacity", async () => {
    const prisma = buildPrisma({
      candidates: [candidate({ id: PKG_C, studentId: STUDENT_C })],
      siblings: [
        {
          id: PKG_C_OLDER_WITH_BALANCE,
          teacherId: TEACHER_ID,
          studentId: STUDENT_C,
          status: "active",
          classesUsed: 6,
          classesTotal: 8,
          expiresAt: new Date("2020-01-01T00:00:00Z"),
        },
      ],
    });

    const result = await sendPackageConsumedNudges({ prisma, emit });

    expect(result.sent).toBe(1);
    expect(enqueueTeacherMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ packageId: PKG_C }),
    );
  });

  it("skips archived pairings", async () => {
    const prisma = buildPrisma({
      candidates: [
        candidate({ id: PKG_A, studentId: STUDENT_A }),
        candidate({ id: PKG_B, studentId: STUDENT_B }),
      ],
      archived: [{ teacherId: TEACHER_ID, studentId: STUDENT_B }],
    });

    const result = await sendPackageConsumedNudges({ prisma, emit });

    expect(result.sent).toBe(1);
    expect(enqueueTeacherMock).not.toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ studentId: STUDENT_B }),
    );
  });

  it("never re-nudges a package (dedup off prior notification metadata)", async () => {
    const prisma = buildPrisma({
      candidates: [candidate({ id: PKG_A, studentId: STUDENT_A })],
      priorNudgedPackageIds: [PKG_A],
    });

    const result = await sendPackageConsumedNudges({ prisma, emit });

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(enqueueStudentMock).not.toHaveBeenCalled();
    expect(enqueueTeacherMock).not.toHaveBeenCalled();
  });

  it("writes only the teacher row when the student disabled the category", async () => {
    const prisma = buildPrisma({
      candidates: [
        candidate({
          id: PKG_A,
          studentId: STUDENT_A,
          student: { notificationPrefs: { expiry_reminders: false } },
        }),
      ],
    });

    const result = await sendPackageConsumedNudges({ prisma, emit });

    expect(result.sent).toBe(1);
    expect(enqueueTeacherMock).toHaveBeenCalledTimes(1);
    // The teacher email must not claim a student notice went out when the
    // student turned the category off.
    expect(enqueueTeacherMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ packageId: PKG_A, studentNotified: false }),
    );
    expect(enqueueStudentMock).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
