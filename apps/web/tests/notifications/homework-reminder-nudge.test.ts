import { beforeEach, describe, expect, it, vi } from "vitest";

// Due-soon/overdue homework nudges (docs/features/homework.md slice
// 6) must skip archived pairings and students who muted "class_materials",
// and must dedup by assignmentId so the daily cron is safe to re-run — same
// guarantees as package-expiry-nudge.test.ts.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ACTIVE = "22222222-2222-4222-8222-22222222222a";
const STUDENT_ARCHIVED = "22222222-2222-4222-8222-22222222222b";
const STUDENT_OPTED_OUT = "22222222-2222-4222-8222-22222222222c";
const ASSIGNMENT_ACTIVE = "33333333-3333-4333-8333-33333333333a";
const ASSIGNMENT_ARCHIVED = "33333333-3333-4333-8333-33333333333b";
const ASSIGNMENT_OPTED_OUT = "33333333-3333-4333-8333-33333333333c";
const BOOKING_ID = "44444444-4444-4444-8444-444444444444";

const enqueueDueSoon = vi.fn(async (..._args: unknown[]) => "notif-id");
const enqueueOverdue = vi.fn(async (..._args: unknown[]) => "notif-id");
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueHomeworkDueSoon: (...args: unknown[]) => enqueueDueSoon(...args),
  enqueueHomeworkOverdue: (...args: unknown[]) => enqueueOverdue(...args),
}));

vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: vi.fn(async () => {}),
}));

const { sendHomeworkDueSoonNudges, sendHomeworkOverdueNudges } =
  await import("@/lib/notifications/homework-reminder-nudge");

type AssignmentCandidate = {
  id: string;
  title: string;
  teacherId: string;
  bookingId: string;
  booking: { studentId: string };
};

function buildPrisma(opts: {
  candidates: AssignmentCandidate[];
  archived: { teacherId: string; studentId: string }[];
  prefs?: Record<string, unknown>;
  priorNudges?: string[];
}) {
  return {
    assignment: { findMany: async () => opts.candidates },
    teacherStudent: {
      findMany: async ({ where }: any) => {
        const teacherIds: string[] = where.teacherId.in;
        const studentIds: string[] = where.studentId.in;
        return opts.archived.filter(
          (l) => teacherIds.includes(l.teacherId) && studentIds.includes(l.studentId),
        );
      },
    },
    student: {
      findMany: async ({ where }: any) => {
        const ids: string[] = where.id.in;
        return ids.map((id) => ({ id, notificationPrefs: opts.prefs?.[id] ?? null }));
      },
    },
    notification: {
      findMany: async () =>
        (opts.priorNudges ?? []).map((assignmentId) => ({ metadata: { assignmentId } })),
    },
  } as any;
}

const emit = vi.fn(async () => {});

beforeEach(() => {
  enqueueDueSoon.mockClear();
  enqueueOverdue.mockClear();
  emit.mockClear();
});

const candidates: AssignmentCandidate[] = [
  {
    id: ASSIGNMENT_ACTIVE,
    title: "Essay",
    teacherId: TEACHER_ID,
    bookingId: BOOKING_ID,
    booking: { studentId: STUDENT_ACTIVE },
  },
  {
    id: ASSIGNMENT_ARCHIVED,
    title: "Essay 2",
    teacherId: TEACHER_ID,
    bookingId: BOOKING_ID,
    booking: { studentId: STUDENT_ARCHIVED },
  },
  {
    id: ASSIGNMENT_OPTED_OUT,
    title: "Essay 3",
    teacherId: TEACHER_ID,
    bookingId: BOOKING_ID,
    booking: { studentId: STUDENT_OPTED_OUT },
  },
];

describe("sendHomeworkDueSoonNudges", () => {
  it("nudges the active pairing and skips archived + opted-out students", async () => {
    const prisma = buildPrisma({
      candidates,
      archived: [{ teacherId: TEACHER_ID, studentId: STUDENT_ARCHIVED }],
      prefs: { [STUDENT_OPTED_OUT]: { class_materials: false } },
    });

    const result = await sendHomeworkDueSoonNudges({ prisma, emit });

    expect(result.sent).toBe(1);
    expect(enqueueDueSoon).toHaveBeenCalledTimes(1);
    expect(enqueueDueSoon).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ studentId: STUDENT_ACTIVE, assignmentId: ASSIGNMENT_ACTIVE }),
    );
  });

  it("dedups by assignmentId — an already-nudged assignment is skipped, not re-sent", async () => {
    const prisma = buildPrisma({
      candidates: [candidates[0]],
      archived: [],
      priorNudges: [ASSIGNMENT_ACTIVE],
    });

    const result = await sendHomeworkDueSoonNudges({ prisma, emit });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(enqueueDueSoon).not.toHaveBeenCalled();
  });
});

describe("sendHomeworkOverdueNudges", () => {
  it("nudges the active pairing and skips archived + opted-out students", async () => {
    const prisma = buildPrisma({
      candidates,
      archived: [{ teacherId: TEACHER_ID, studentId: STUDENT_ARCHIVED }],
      prefs: { [STUDENT_OPTED_OUT]: { class_materials: false } },
    });

    const result = await sendHomeworkOverdueNudges({ prisma, emit });

    expect(result.sent).toBe(1);
    expect(enqueueOverdue).toHaveBeenCalledTimes(1);
    expect(enqueueOverdue).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ studentId: STUDENT_ACTIVE, assignmentId: ASSIGNMENT_ACTIVE }),
    );
  });
});
