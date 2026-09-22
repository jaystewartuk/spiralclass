import { beforeEach, describe, expect, it, vi } from "vitest";

// This transitively pulls in lib/materials/handlers.ts, which now calls the
// homework auto-draft check (lib/homework/auto-draft.ts) — a server module
// (`import "server-only"`); neutralize the guard, same as homework-wire.test.ts.
vi.mock("server-only", () => ({}));

// Level-gated material library actions (the non-upload ones). Every action
// scopes on teacher_id (tenant isolation). Pin: the teacher-scoping no-ops, the
// best-effort storage delete before the row delete, the reorder swap, the
// assignment target verification, and the idempotent assign/complete writes.

const state = {
  material: null as { id: string; storagePath: string | null; bookingId?: string | null } | null,
  moveItem: null as { id: string; levelId: string | null; position: number } | null,
  neighbor: null as { id: string; position: number } | null,
  link: { studentId: "s1" } as { studentId: string } | null,
  ownedMaterial: { id: "m1" } as { id: string } | null,
  completedCount: 1,
  // The pre-existing assignment row (null = first-time assignment → notify).
  existingAssignment: null as { id: string } | null,
};

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn(), flushAnalytics: vi.fn() }));

const removeMaterialObject = vi.fn(async () => {});
vi.mock("@/lib/storage/materials-upload", () => ({
  removeMaterialObject,
  resolveMaterialAttachment: vi.fn(),
}));

const notifyLibraryMaterialAssigned = vi.fn(async () => {});
vi.mock("@/lib/notifications/materials", () => ({
  notifyLibraryMaterialAssigned,
}));
// Pulled in by uploadBookingMaterialAction (D-69's merged materials.ts logic,
// now living in this action file) — not exercised by these tests, stubbed so
// the module graph doesn't reach the real Inngest client (which needs env).
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueMaterialsSend: vi.fn(async () => "notif-id"),
}));
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: vi.fn(async () => {}),
}));

const updateMany = vi.fn(async () => ({ count: 1 }));
const del = vi.fn(async () => ({}));
const upsert = vi.fn(async () => ({}));
const itemDeleteMany = vi.fn(async () => ({ count: 1 }));
const itemUpdateMany = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({
  count: state.completedCount,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    libraryMaterial: {
      updateMany,
      delete: del,
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // verifyAssignmentTargets material lookup uses id+teacherId
        if (where.position !== undefined) return state.neighbor;
        if (
          where.id &&
          state.moveItem &&
          where.teacherId &&
          "levelId" in where === false &&
          where.id === "move"
        ) {
          return state.material;
        }
        // delete path
        return state.material ?? state.moveItem;
      }),
    },
    studentLibraryItem: {
      upsert,
      deleteMany: itemDeleteMany,
      updateMany: itemUpdateMany,
      findUnique: vi.fn(async () => state.existingAssignment),
    },
    teacherStudent: { findUnique: vi.fn(async () => state.link) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  },
}));

const {
  setLibraryMaterialArchivedAction,
  deleteLibraryMaterialAction,
  assignLibraryMaterialAction,
  unassignLibraryMaterialAction,
  setLibraryItemCompletedAction,
} = await import("@/app/actions/library");

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.material = { id: "m1", storagePath: "t1/library/x.pdf" };
  state.link = { studentId: "s1" };
  state.ownedMaterial = { id: "m1" };
  state.completedCount = 1;
  state.existingAssignment = null;
});

describe("setLibraryMaterialArchivedAction", () => {
  it("scopes the archive update to the teacher", async () => {
    await setLibraryMaterialArchivedAction(form({ materialId: "m1", archived: "true" }));
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "m1", teacherId: "t1" },
      data: { archived: true },
    });
  });

  it("is a no-op without a material id", async () => {
    await setLibraryMaterialArchivedAction(form({}));
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("deleteLibraryMaterialAction", () => {
  it("frees the storage object before deleting the row", async () => {
    await deleteLibraryMaterialAction(form({ materialId: "m1" }));
    expect(removeMaterialObject).toHaveBeenCalledWith("t1/library/x.pdf");
    expect(del).toHaveBeenCalledWith({ where: { id: "m1" } });
  });

  it("is a no-op when the material isn't the teacher's", async () => {
    state.material = null;
    await deleteLibraryMaterialAction(form({ materialId: "mX" }));
    expect(del).not.toHaveBeenCalled();
  });

  it("revalidates the class page a CLASS-SCOPED delete came from, and only that", async () => {
    // A booking-scoped material renders on its class page rather than the
    // library list, so that is the page the delete was issued from and the one
    // revalidated. One call, never two — see D-174.
    state.material = { id: "m1", storagePath: null, bookingId: "b1" };
    await deleteLibraryMaterialAction(form({ materialId: "m1" }));
    expect(revalidatePathMock.mock.calls.map((c) => c[0])).toEqual(["/dashboard/classes/b1"]);
  });

  it("does NOT touch the class lists when a pure library material is deleted", async () => {
    // No bookingId → not tied to any class, so the class-list chip is unaffected.
    state.material = { id: "m1", storagePath: "t1/library/x.pdf", bookingId: null };
    await deleteLibraryMaterialAction(form({ materialId: "m1" }));
    const paths = revalidatePathMock.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/dashboard/classes");
    expect(paths).not.toContain("/my-classes");
  });
});

describe("assignLibraryMaterialAction", () => {
  it("requires both ids", async () => {
    const res = await assignLibraryMaterialAction(undefined, form({ studentId: "s1" }));
    expect(res).toHaveProperty("error");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses when the student/material pairing can't be verified", async () => {
    state.link = null;
    const res = await assignLibraryMaterialAction(
      undefined,
      form({ studentId: "s1", materialId: "m1" }),
    );
    expect(res).toHaveProperty("error");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("upserts the assignment idempotently", async () => {
    const res = await assignLibraryMaterialAction(
      undefined,
      form({ studentId: "s1", materialId: "m1" }),
    );
    expect(res).toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("notifies the student on a first-time assignment", async () => {
    state.existingAssignment = null;
    await assignLibraryMaterialAction(undefined, form({ studentId: "s1", materialId: "m1" }));
    expect(notifyLibraryMaterialAssigned).toHaveBeenCalledWith(expect.anything(), {
      teacherId: "t1",
      studentId: "s1",
      libraryMaterialId: "m1",
    });
  });

  it("does not re-notify when the material was already assigned", async () => {
    state.existingAssignment = { id: "sli1" };
    await assignLibraryMaterialAction(undefined, form({ studentId: "s1", materialId: "m1" }));
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(notifyLibraryMaterialAssigned).not.toHaveBeenCalled();
  });
});

describe("unassignLibraryMaterialAction", () => {
  it("deletes only the teacher's own assignment", async () => {
    await unassignLibraryMaterialAction(form({ studentId: "s1", materialId: "m1" }));
    expect(itemDeleteMany).toHaveBeenCalledWith({
      where: { teacherId: "t1", studentId: "s1", libraryMaterialId: "m1" },
    });
  });
});

describe("setLibraryItemCompletedAction", () => {
  it("marks complete with a timestamp + actor", async () => {
    await setLibraryItemCompletedAction(
      form({ studentId: "s1", materialId: "m1", completed: "true" }),
    );
    const data = itemUpdateMany.mock.calls[0][0].data as { completedBy: string; completedAt: Date };
    expect(data.completedBy).toBe("teacher");
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it("clears completion when completed=false", async () => {
    await setLibraryItemCompletedAction(
      form({ studentId: "s1", materialId: "m1", completed: "false" }),
    );
    const data = itemUpdateMany.mock.calls[0][0].data as { completedBy: null; completedAt: null };
    expect(data.completedAt).toBeNull();
    expect(data.completedBy).toBeNull();
  });
});
