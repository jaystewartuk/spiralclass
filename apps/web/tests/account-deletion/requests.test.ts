import { describe, expect, it, vi } from "vitest";
import {
  DELETION_GRACE_PERIOD_MS,
  teacherHasUnusedActivePackages,
  pendingTeacherDeletionRequest,
  fileTeacherDeletionRequest,
  cancelTeacherDeletionRequests,
} from "@/lib/account-deletion/requests";

// The teacher-side deletion helpers (mirror of the existing student helpers)
// back both the web server actions and the /api/mobile/account/deletion route,
// so the request/cancel/blocking logic lives in one place. They take an
// injectable `db`, so we exercise them against a fake.

describe("DELETION_GRACE_PERIOD_MS", () => {
  it("is exactly 30 days", () => {
    expect(DELETION_GRACE_PERIOD_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("teacherHasUnusedActivePackages", () => {
  function fakeDb(count: number) {
    return {
      package: {
        fields: { classesTotal: "classesTotal" },
        count: vi.fn(async () => count),
      },
    } as never;
  }

  it("is true when an active package still has classes left", async () => {
    expect(await teacherHasUnusedActivePackages("t1", fakeDb(2))).toBe(true);
  });

  it("is false when nothing is blocking", async () => {
    expect(await teacherHasUnusedActivePackages("t1", fakeDb(0))).toBe(false);
  });
});

describe("pendingTeacherDeletionRequest", () => {
  it("queries the teacher's pending request", async () => {
    const findFirst = vi.fn(async () => ({ id: "r1" }));
    const db = { accountDeletionRequest: { findFirst } } as never;
    await pendingTeacherDeletionRequest("t1", db);
    expect(findFirst).toHaveBeenCalledWith({
      where: { subjectType: "teacher", subjectId: "t1", status: "pending" },
      orderBy: { scheduledFor: "asc" },
    });
  });
});

describe("fileTeacherDeletionRequest", () => {
  function fakeDb(existing: unknown) {
    const create = vi.fn(async () => ({ id: "new" }));
    const findFirst = vi.fn(async () => existing);
    const db = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ accountDeletionRequest: { findFirst, create } }),
      ),
      __create: create,
      __findFirst: findFirst,
    } as never;
    return db as never & { __create: typeof create; __findFirst: typeof findFirst };
  }

  it("creates a pending row when none exists", async () => {
    const db = fakeDb(null);
    const scheduledFor = new Date("2026-07-12T00:00:00.000Z");
    const res = await fileTeacherDeletionRequest(
      { teacherId: "t1", email: "a@b.com", scheduledFor },
      db,
    );
    expect(res).toEqual({ created: true });
    expect((db as { __create: ReturnType<typeof vi.fn> }).__create).toHaveBeenCalledWith({
      data: { subjectType: "teacher", subjectId: "t1", email: "a@b.com", scheduledFor },
    });
  });

  it("is idempotent: skips when a pending row already exists", async () => {
    const db = fakeDb({ id: "existing" });
    const res = await fileTeacherDeletionRequest(
      { teacherId: "t1", email: "a@b.com", scheduledFor: new Date() },
      db,
    );
    expect(res).toEqual({ created: false });
    expect((db as { __create: ReturnType<typeof vi.fn> }).__create).not.toHaveBeenCalled();
  });
});

describe("cancelTeacherDeletionRequests", () => {
  it("flips the teacher's pending rows to cancelled", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = { accountDeletionRequest: { updateMany } } as never;
    const res = await cancelTeacherDeletionRequests("t1", db);
    expect(res).toEqual({ cancelled: 1 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { subjectType: "teacher", subjectId: "t1", status: "pending" },
      data: { status: "cancelled", cancelledAt: expect.any(Date) },
    });
  });
});
