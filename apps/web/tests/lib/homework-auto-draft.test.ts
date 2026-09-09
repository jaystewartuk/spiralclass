import { beforeEach, describe, expect, it, vi } from "vitest";

// auto-draft.ts is a server module (`import "server-only"`); neutralize the
// guard, same as homework-wire.test.ts. Covers: skips a body with no
// [!homework]/[!exercise] callout, fires at most once per material (no
// duplicate on a second save), defaults dueAt to the student's next
// scheduled class (or null when none), and never throws even when a
// downstream call fails (best-effort, must not fail the content save it
// piggybacks on).
vi.mock("server-only", () => ({}));

const state: {
  existingAssignmentForMaterial: boolean;
  nextClassStart: Date | null;
} = { existingAssignmentForMaterial: false, nextClassStart: null };

const assignmentFindFirst = vi.fn(async () =>
  state.existingAssignmentForMaterial ? { id: "existing-a1" } : null,
);
const assignmentCreate = vi.fn(async ({ data }: any) => ({ id: "new-a1", ...data }));
const bookingFindFirst = vi.fn(async () =>
  state.nextClassStart ? { scheduledStart: state.nextClassStart } : null,
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    assignment: {
      findFirst: assignmentFindFirst,
      create: assignmentCreate,
    },
    booking: {
      findFirst: bookingFindFirst,
    },
  },
}));

const trackEventMock = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: trackEventMock }));

const enqueueHomeworkAssignedMock = vi.fn(async () => "notif-1");
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueHomeworkAssigned: enqueueHomeworkAssignedMock,
}));
const emitNotificationQueuedMock = vi.fn(async () => {});
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: emitNotificationQueuedMock,
}));

const { maybeAutoDraftAssignmentFromMaterial } = await import("@/lib/homework/auto-draft");

const BASE_INPUT = {
  teacherId: "t1",
  materialId: "m1",
  bookingId: "b1",
  studentId: "s1",
  locale: "en" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.existingAssignmentForMaterial = false;
  state.nextClassStart = null;
});

describe("maybeAutoDraftAssignmentFromMaterial", () => {
  it("does nothing for a body with no homework/exercise callout", async () => {
    await maybeAutoDraftAssignmentFromMaterial({ ...BASE_INPUT, body: "# Just a lesson" });
    expect(assignmentCreate).not.toHaveBeenCalled();
  });

  it("creates an assignment for a [!homework] callout", async () => {
    await maybeAutoDraftAssignmentFromMaterial({
      ...BASE_INPUT,
      body: "> [!homework]\n> Write 5 sentences.",
    });
    expect(assignmentCreate).toHaveBeenCalledTimes(1);
    const arg = (assignmentCreate.mock.calls as any)[0][0];
    expect(arg.data).toMatchObject({
      bookingId: "b1",
      teacherId: "t1",
      sourceMaterialId: "m1",
      title: "Homework",
    });
  });

  it("also fires for a [!exercise] callout", async () => {
    await maybeAutoDraftAssignmentFromMaterial({
      ...BASE_INPUT,
      body: "> [!exercise]\n> Fill in the blanks.",
    });
    expect(assignmentCreate).toHaveBeenCalledTimes(1);
  });

  it("localizes the default title to the teacher's locale", async () => {
    await maybeAutoDraftAssignmentFromMaterial({
      ...BASE_INPUT,
      locale: "es-MX",
      body: "> [!homework]\n> Escribe 5 oraciones.",
    });
    const arg = (assignmentCreate.mock.calls as any)[0][0];
    expect(arg.data.title).toBe("Tareas");
  });

  it("does not create a second assignment once one already references this material", async () => {
    state.existingAssignmentForMaterial = true;
    await maybeAutoDraftAssignmentFromMaterial({
      ...BASE_INPUT,
      body: "> [!homework]\n> Write 5 sentences.",
    });
    expect(assignmentCreate).not.toHaveBeenCalled();
  });

  it("defaults dueAt to the student's next scheduled class", async () => {
    const next = new Date("2026-08-01T20:00:00.000Z");
    state.nextClassStart = next;
    await maybeAutoDraftAssignmentFromMaterial({
      ...BASE_INPUT,
      body: "> [!homework]\n> Write 5 sentences.",
    });
    const arg = (assignmentCreate.mock.calls as any)[0][0];
    expect(arg.data.dueAt).toBe(next);
    expect(bookingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teacherId: "t1",
          studentId: "s1",
          status: "scheduled",
        }),
      }),
    );
  });

  it("leaves dueAt null when no future class is scheduled", async () => {
    state.nextClassStart = null;
    await maybeAutoDraftAssignmentFromMaterial({
      ...BASE_INPUT,
      body: "> [!homework]\n> Write 5 sentences.",
    });
    const arg = (assignmentCreate.mock.calls as any)[0][0];
    expect(arg.data.dueAt).toBeNull();
  });

  it("enqueues the student-facing homework_assigned notification", async () => {
    await maybeAutoDraftAssignmentFromMaterial({
      ...BASE_INPUT,
      body: "> [!homework]\n> Write 5 sentences.",
    });
    expect(enqueueHomeworkAssignedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ studentId: "s1", teacherId: "t1", bookingId: "b1" }),
    );
    expect(emitNotificationQueuedMock).toHaveBeenCalled();
  });

  it("tracks creation with surface: auto_draft", async () => {
    await maybeAutoDraftAssignmentFromMaterial({
      ...BASE_INPUT,
      body: "> [!homework]\n> Write 5 sentences.",
    });
    expect(trackEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "homework_assignment_created",
        properties: expect.objectContaining({ surface: "auto_draft" }),
      }),
    );
  });

  it("never throws, even when the downstream notification enqueue fails", async () => {
    enqueueHomeworkAssignedMock.mockRejectedValueOnce(new Error("db down"));
    await expect(
      maybeAutoDraftAssignmentFromMaterial({
        ...BASE_INPUT,
        body: "> [!homework]\n> Write 5 sentences.",
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws when the assignment lookup itself fails", async () => {
    assignmentFindFirst.mockRejectedValueOnce(new Error("db down"));
    await expect(
      maybeAutoDraftAssignmentFromMaterial({
        ...BASE_INPUT,
        body: "> [!homework]\n> Write 5 sentences.",
      }),
    ).resolves.toBeUndefined();
    expect(assignmentCreate).not.toHaveBeenCalled();
  });
});
