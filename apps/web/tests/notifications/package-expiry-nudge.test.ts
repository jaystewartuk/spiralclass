import { beforeEach, describe, expect, it, vi } from "vitest";

// The pre-expiry nudge sweep must skip archived ("dar de baja") pairings so a
// churned student isn't pinged to rebook. The dispatcher's link-archived gate
// is the enforcing layer; this query-level pre-filter just avoids creating rows
// only to suppress them. We assert the eligible set excludes archived links.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ACTIVE = "22222222-2222-4222-8222-22222222222a";
const STUDENT_ARCHIVED = "22222222-2222-4222-8222-22222222222b";
const PKG_ACTIVE = "33333333-3333-4333-8333-33333333333a";
const PKG_ARCHIVED = "33333333-3333-4333-8333-33333333333b";

const enqueueMock = vi.fn(async (..._args: unknown[]) => "notif-id");
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueuePackageExpiryNudge: (...args: unknown[]) => enqueueMock(...args),
}));

// Avoid pulling the Inngest client (and its server-env validation) in via the
// transitive `./events` import — the sweep takes `emit` via deps anyway.
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: vi.fn(async () => {}),
}));

const { sendPackageExpiryNudges } = await import("@/lib/notifications/package-expiry-nudge");

type Candidate = {
  id: string;
  teacherId: string;
  studentId: string;
  classesTotal: number;
  classesUsed: number;
  student: { notificationPrefs: unknown };
};

function buildPrisma(opts: {
  candidates: Candidate[];
  archived: { teacherId: string; studentId: string }[];
}) {
  return {
    package: {
      findMany: async ({ select }: any) =>
        opts.candidates.map((c) => {
          // Honor the select shape the sweep uses.
          void select;
          return c;
        }),
    },
    teacherStudent: {
      findMany: async ({ where }: any) => {
        // Mirror the `archivedAt not null` + teacher/student `in` filter.
        const teacherIds: string[] = where.teacherId.in;
        const studentIds: string[] = where.studentId.in;
        return opts.archived.filter(
          (l) => teacherIds.includes(l.teacherId) && studentIds.includes(l.studentId),
        );
      },
    },
    notification: {
      // No prior nudges → nothing already-nudged.
      findMany: async () => [],
    },
  } as any;
}

const emit = vi.fn(async () => {});

beforeEach(() => {
  enqueueMock.mockClear();
  emit.mockClear();
});

describe("sendPackageExpiryNudges — archived pairing pre-filter", () => {
  const candidates: Candidate[] = [
    {
      id: PKG_ACTIVE,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ACTIVE,
      classesTotal: 10,
      classesUsed: 4,
      student: { notificationPrefs: null },
    },
    {
      id: PKG_ARCHIVED,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ARCHIVED,
      classesTotal: 10,
      classesUsed: 4,
      student: { notificationPrefs: null },
    },
  ];

  it("nudges the active pairing and skips the archived one", async () => {
    const prisma = buildPrisma({
      candidates,
      archived: [{ teacherId: TEACHER_ID, studentId: STUDENT_ARCHIVED }],
    });

    const result = await sendPackageExpiryNudges({ prisma, emit });

    expect(result.sent).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ studentId: STUDENT_ACTIVE, packageId: PKG_ACTIVE }),
    );
    // The archived student is never enqueued.
    expect(enqueueMock).not.toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ studentId: STUDENT_ARCHIVED }),
    );
  });

  it("nudges both when neither pairing is archived", async () => {
    const prisma = buildPrisma({ candidates, archived: [] });
    const result = await sendPackageExpiryNudges({ prisma, emit });
    expect(result.sent).toBe(2);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });
});
