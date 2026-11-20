import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Tenant scoping of the LessonInsight writes in insight-actions.ts (#62,
// D-175). Confirm, edit and dismiss each used to write the row by id alone,
// correct only because `ownedInsight` had just read it as the teacher's. The
// fake below honours `teacherId` the way Prisma does, and `update` throws when
// its `where` matches nothing (P2025), so a write that names the wrong tenant
// cannot quietly succeed here either.

const recompute = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("./profile", () => ({
  recomputeStudentProfile: (...args: unknown[]) => recompute(...args),
}));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { confirmInsightFor, editInsightFor, dismissInsightFor } = await import("./insight-actions");

const T1 = "teacher-1";
const T2 = "teacher-2";

type Row = {
  id: string;
  bookingId: string;
  teacherId: string;
  category: "grammar";
  summary: string;
  confirmedAt: Date | null;
  dismissedAt: Date | null;
};
type Where = { id?: string; teacherId?: string };

function makeDb(opts: { readAs?: string } = {}) {
  const rows: Row[] = [
    {
      id: "i1",
      bookingId: "b1",
      teacherId: T1,
      category: "grammar",
      summary: "ser vs estar",
      confirmedAt: null,
      dismissedAt: null,
    },
    {
      id: "i2",
      bookingId: "b2",
      teacherId: T2,
      category: "grammar",
      summary: "ser vs estar",
      confirmedAt: null,
      dismissedAt: null,
    },
  ];
  const matches = (r: Row, where: Where) =>
    (where.id === undefined || r.id === where.id) &&
    (where.teacherId === undefined || r.teacherId === where.teacherId);

  const lessonInsight = {
    // `readAs` makes the ownership read return the row as if it belonged to
    // that teacher: the one way an id-only write could reach a row the
    // teacher does not own is a row whose teacher is not the one it was read
    // as, so that is what the mismatch tests construct.
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      const r = rows.find((x) => (opts.readAs ? x.id === where.id : matches(x, where)));
      return r ? { ...r, booking: { studentId: "s1" } } : null;
    }),
    update: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
      Object.assign(r, data);
      return r;
    }),
  };
  const prisma = { lessonInsight } as unknown as PrismaClient;
  return { prisma, rows, lessonInsight };
}

beforeEach(() => recompute.mockClear());

describe("confirm / edit / dismiss write only the calling teacher's insight", () => {
  it("confirm writes with a where scoped to the teacher", async () => {
    const { prisma, lessonInsight } = makeDb();
    const res = await confirmInsightFor(prisma, T1, "i1");
    expect(res).toEqual({ ok: true, bookingId: "b1", studentId: "s1" });
    expect(lessonInsight.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "i1", teacherId: T1 } }),
    );
  });

  it("edit writes with a where scoped to the teacher", async () => {
    const { prisma, lessonInsight } = makeDb();
    const res = await editInsightFor(prisma, T1, "i1", { summary: "por vs para" });
    expect(res.ok).toBe(true);
    expect(lessonInsight.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "i1", teacherId: T1 } }),
    );
  });

  it("dismiss writes with a where scoped to the teacher", async () => {
    const { prisma, lessonInsight } = makeDb();
    const res = await dismissInsightFor(prisma, T1, "i1");
    expect(res.ok).toBe(true);
    expect(lessonInsight.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "i1", teacherId: T1 } }),
    );
  });

  it("another teacher's insight id is not found, and nothing is written", async () => {
    const { prisma, rows, lessonInsight } = makeDb();
    const res = await confirmInsightFor(prisma, T1, "i2");
    expect(res).toEqual({ ok: false, reason: "not-found" });
    expect(lessonInsight.update).not.toHaveBeenCalled();
    expect(rows[1]!.confirmedAt).toBeNull();
  });

  it("confirm does not change a row whose teacher is not the one it was read as", async () => {
    const { prisma, rows } = makeDb({ readAs: T1 });
    const res = await confirmInsightFor(prisma, T1, "i2");
    expect(res).toEqual({ ok: false, reason: "save-failed" });
    expect(rows[1]!.confirmedAt).toBeNull();
    expect(recompute).not.toHaveBeenCalled();
  });

  it("edit does not change a row whose teacher is not the one it was read as", async () => {
    const { prisma, rows } = makeDb({ readAs: T1 });
    const res = await editInsightFor(prisma, T1, "i2", { summary: "rewritten" });
    expect(res).toEqual({ ok: false, reason: "save-failed" });
    expect(rows[1]!.summary).toBe("ser vs estar");
    expect(recompute).not.toHaveBeenCalled();
  });

  it("dismiss does not change a row whose teacher is not the one it was read as", async () => {
    const { prisma, rows } = makeDb({ readAs: T1 });
    const res = await dismissInsightFor(prisma, T1, "i2");
    expect(res).toEqual({ ok: false, reason: "save-failed" });
    expect(rows[1]!.dismissedAt).toBeNull();
    expect(recompute).not.toHaveBeenCalled();
  });
});
