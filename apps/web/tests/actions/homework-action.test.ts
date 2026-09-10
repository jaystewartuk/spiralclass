import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveTeacherAssignment (lib/homework/access.ts) is a server module
// (`import "server-only"`); neutralize the guard, same as homework-wire.test.ts.
vi.mock("server-only", () => ({}));

// Web dashboard mirror of the mobile teacher assignment routes
// (docs/features/homework.md) — covers tenant scoping on
// both mutations, title validation, the teacher-timezone due-date
// conversion, and that delete is a silent no-op (not a throw) for an
// assignment the caller doesn't own, matching resolveTeacherAssignment's
// existing 404-not-403 contract.

const TEACHER_ID = "t1";
const OTHER_TEACHER_ID = "t2";
const BOOKING_ID = "b1";
const TEACHER_TZ = "America/Mexico_City"; // UTC-6 (no DST)

type BookingRow = { id: string; teacherId: string };
type AssignmentRow = {
  id: string;
  bookingId: string;
  teacherId: string;
  title: string;
  instructions: string | null;
  dueAt: Date | null;
  allowLateSubmission: boolean;
  allowResubmission: boolean;
};

const state: {
  bookings: Map<string, BookingRow>;
  assignments: Map<string, AssignmentRow>;
  files: Array<{ storagePath: string; assignmentId: string }>;
} = { bookings: new Map(), assignments: new Map(), files: [] };

const revalidatePathMock = vi.fn();
const trackEventMock = vi.fn();
const deleteSubmissionObjectMock = vi.fn(async () => true);
let assignmentIdCounter = 0;

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: TEACHER_ID, timezone: TEACHER_TZ })),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackEventMock,
  flushAnalytics: vi.fn(async () => {}),
}));
vi.mock("@/lib/storage/homework-file", () => ({
  deleteSubmissionObject: deleteSubmissionObjectMock,
}));

// createHomeworkFeedbackAction delegates all business logic to
// lib/homework/feedback.ts (already unit-tested in homework-feedback.test.ts);
// this file only needs to pin the action's own form-parsing, error-mapping,
// and revalidatePath responsibilities.
const createHomeworkFeedbackMock = vi.fn(async (..._: unknown[]) => ({
  id: "f1",
  decision: "approved",
  content: "Nice work",
  score: 8,
  createdAt: "2026-07-10T00:00:00.000Z",
}));
vi.mock("@/lib/homework/feedback", () => ({
  createHomeworkFeedback: (...a: unknown[]) => createHomeworkFeedbackMock(...a),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: vi.fn(async ({ where }: any) => {
        const b = state.bookings.get(where.id);
        if (!b || b.teacherId !== where.teacherId) return null;
        return { ...b };
      }),
    },
    assignment: {
      create: vi.fn(async ({ data }: any) => {
        const row: AssignmentRow = { id: `a${++assignmentIdCounter}`, ...data };
        state.assignments.set(row.id, row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const a = state.assignments.get(where.id);
        if (!a || a.teacherId !== where.teacherId) return null;
        return { ...a };
      }),
      delete: vi.fn(async ({ where }: any) => {
        state.assignments.delete(where.id);
      }),
    },
    homeworkSubmissionFile: {
      findMany: vi.fn(async ({ where }: any) => {
        const assignmentId = where.submission.assignmentId;
        return state.files
          .filter((f) => f.assignmentId === assignmentId)
          .map((f) => ({ storagePath: f.storagePath }));
      }),
    },
  },
}));

const { createAssignmentAction, deleteAssignmentAction, createHomeworkFeedbackAction } =
  await import("@/app/actions/homework");

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  assignmentIdCounter = 0;
  state.assignments = new Map();
  state.files = [];
  state.bookings = new Map([[BOOKING_ID, { id: BOOKING_ID, teacherId: TEACHER_ID }]]);
  createHomeworkFeedbackMock.mockResolvedValue({
    id: "f1",
    decision: "approved",
    content: "Nice work",
    score: 8,
    createdAt: "2026-07-10T00:00:00.000Z",
  });
});

describe("createAssignmentAction", () => {
  it("rejects a booking that doesn't belong to this teacher", async () => {
    state.bookings.set(BOOKING_ID, { id: BOOKING_ID, teacherId: OTHER_TEACHER_ID });
    const result = await createAssignmentAction(
      undefined,
      form({ bookingId: BOOKING_ID, title: "Essay" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.assignments.size).toBe(0);
  });

  it("rejects a blank title", async () => {
    const result = await createAssignmentAction(
      undefined,
      form({ bookingId: BOOKING_ID, title: "   " }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.assignments.size).toBe(0);
  });

  it("creates an assignment scoped to the booking and teacher", async () => {
    const result = await createAssignmentAction(
      undefined,
      form({ bookingId: BOOKING_ID, title: "Essay", instructions: "Write 200 words" }),
    );
    expect(result).toEqual({ ok: true });
    expect(state.assignments.size).toBe(1);
    const created = [...state.assignments.values()][0];
    expect(created).toMatchObject({
      bookingId: BOOKING_ID,
      teacherId: TEACHER_ID,
      title: "Essay",
      instructions: "Write 200 words",
      dueAt: null,
      allowLateSubmission: false,
      allowResubmission: false,
    });
  });

  it("reads the allow-late/allow-resubmit hidden booleans", async () => {
    await createAssignmentAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        title: "Essay",
        allowLateSubmission: "true",
        allowResubmission: "true",
      }),
    );
    const created = [...state.assignments.values()][0];
    expect(created.allowLateSubmission).toBe(true);
    expect(created.allowResubmission).toBe(true);
  });

  it("converts the due-date input as the TEACHER's local time, not the server's", async () => {
    // 2026-08-01T14:00 in America/Mexico_City (UTC-6, no DST) is 20:00 UTC.
    await createAssignmentAction(
      undefined,
      form({ bookingId: BOOKING_ID, title: "Essay", dueAt: "2026-08-01T14:00" }),
    );
    const created = [...state.assignments.values()][0];
    expect(created.dueAt?.toISOString()).toBe("2026-08-01T20:00:00.000Z");
  });

  it("revalidates the class-detail path on success", async () => {
    await createAssignmentAction(undefined, form({ bookingId: BOOKING_ID, title: "Essay" }));
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/classes/${BOOKING_ID}`);
  });

  it("tracks creation with surface: web", async () => {
    await createAssignmentAction(undefined, form({ bookingId: BOOKING_ID, title: "Essay" }));
    expect(trackEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "homework_assignment_created",
        properties: expect.objectContaining({ surface: "web" }),
      }),
    );
  });
});

describe("deleteAssignmentAction", () => {
  function seedAssignment(teacherId = TEACHER_ID) {
    const row: AssignmentRow = {
      id: "a-existing",
      bookingId: BOOKING_ID,
      teacherId,
      title: "Essay",
      instructions: null,
      dueAt: null,
      allowLateSubmission: true,
      allowResubmission: false,
    };
    state.assignments.set(row.id, row);
    return row;
  }

  it("is a silent no-op for an assignment owned by another teacher (never throws)", async () => {
    seedAssignment(OTHER_TEACHER_ID);
    await expect(
      deleteAssignmentAction(form({ assignmentId: "a-existing", bookingId: BOOKING_ID })),
    ).resolves.toBeUndefined();
    expect(state.assignments.has("a-existing")).toBe(true);
  });

  it("deletes an owned assignment and best-effort cleans up its files", async () => {
    seedAssignment();
    state.files = [
      { assignmentId: "a-existing", storagePath: "homework/t1/a-existing/s1/x.pdf" },
      { assignmentId: "a-existing", storagePath: "homework/t1/a-existing/s1/y.pdf" },
    ];
    await deleteAssignmentAction(form({ assignmentId: "a-existing", bookingId: BOOKING_ID }));
    expect(state.assignments.has("a-existing")).toBe(false);
    expect(deleteSubmissionObjectMock).toHaveBeenCalledTimes(2);
    expect(deleteSubmissionObjectMock).toHaveBeenCalledWith("homework/t1/a-existing/s1/x.pdf");
  });

  it("revalidates the class-detail path", async () => {
    seedAssignment();
    await deleteAssignmentAction(form({ assignmentId: "a-existing", bookingId: BOOKING_ID }));
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/classes/${BOOKING_ID}`);
  });

  it("tracks deletion with surface: web", async () => {
    seedAssignment();
    await deleteAssignmentAction(form({ assignmentId: "a-existing", bookingId: BOOKING_ID }));
    expect(trackEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "homework_assignment_deleted",
        properties: expect.objectContaining({ surface: "web" }),
      }),
    );
  });
});

describe("createHomeworkFeedbackAction", () => {
  function feedbackForm(entries: Record<string, string>): FormData {
    return form({
      attemptId: "at1",
      bookingId: BOOKING_ID,
      assignmentId: "a1",
      decision: "approved",
      content: "Nice work",
      ...entries,
    });
  }

  it("rejects blank feedback content before calling the shared lib", async () => {
    const result = await createHomeworkFeedbackAction(undefined, feedbackForm({ content: "  " }));
    expect(result?.error).toBeTruthy();
    expect(createHomeworkFeedbackMock).not.toHaveBeenCalled();
  });

  it("delegates to the shared lib with surface: web, forwarding the decision/content/score", async () => {
    const result = await createHomeworkFeedbackAction(undefined, feedbackForm({ score: "9" }));
    expect(result).toEqual({ ok: true });
    expect(createHomeworkFeedbackMock).toHaveBeenCalledWith(
      { id: TEACHER_ID, timezone: TEACHER_TZ },
      "at1",
      { decision: "approved", content: "Nice work", score: 9 },
      "web",
    );
  });

  it("passes a null score when the field is left blank", async () => {
    await createHomeworkFeedbackAction(undefined, feedbackForm({}));
    const arg = createHomeworkFeedbackMock.mock.calls[0][2] as { score: number | null };
    expect(arg.score).toBeNull();
  });

  it("maps an already-reviewed error from the shared lib to a friendly message", async () => {
    const { ApiAuthError } = await import("@/lib/api/auth");
    createHomeworkFeedbackMock.mockRejectedValue(new ApiAuthError(409, "already-reviewed"));
    const result = await createHomeworkFeedbackAction(undefined, feedbackForm({}));
    expect(result?.error).toBeTruthy();
  });

  it("revalidates both the review page and the class-detail page on success", async () => {
    await createHomeworkFeedbackAction(undefined, feedbackForm({}));
    // The review page is the one the feedback form is on, so it is the one the
    // response has to carry fresh (D-174) — and the only one revalidated.
    expect(revalidatePathMock.mock.calls.map((c) => c[0])).toEqual([
      `/dashboard/classes/${BOOKING_ID}/homework/a1`,
    ]);
  });
});
