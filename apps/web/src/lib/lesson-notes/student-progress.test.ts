import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { gradeVocabularyFor } from "./student-progress";

// Tenant scoping of the VocabularyReview write in student-progress.ts (#62,
// D-175). The grade used to be written by row id alone, correct only because
// the read just before it was scoped to the signed-in student's identity set.
// A Student row is per teacher, so `studentId` is the tenant here. The fake
// honours `studentId: { in }` the way Prisma does, and `update` throws when its
// `where` matches nothing (P2025).

type Row = {
  id: string;
  studentId: string;
  intervalDays: number;
  easeFactor: number;
  lastReviewedAt: Date | null;
};
type Where = { id?: string; studentId?: { in: string[] } };

function makeDb(opts: { readAnyRow?: boolean } = {}) {
  const rows: Row[] = [
    { id: "r1", studentId: "s1", intervalDays: 0, easeFactor: 2.5, lastReviewedAt: null },
    { id: "r2", studentId: "s-other", intervalDays: 0, easeFactor: 2.5, lastReviewedAt: null },
  ];
  const matches = (r: Row, where: Where) =>
    (where.id === undefined || r.id === where.id) &&
    (where.studentId === undefined || where.studentId.in.includes(r.studentId));

  const vocabularyReview = {
    // `readAnyRow` stands for a row whose student is not the one it was read
    // as — the only way an id-only write could reach another student's row.
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      const r = rows.find((x) => (opts.readAnyRow ? x.id === where.id : matches(x, where)));
      return r ? { ...r } : null;
    }),
    update: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
      Object.assign(r, data);
      return r;
    }),
  };
  return { prisma: { vocabularyReview } as unknown as PrismaClient, rows, vocabularyReview };
}

describe("gradeVocabularyFor writes only the signed-in student's review row", () => {
  it("writes with a where scoped to the student's identity set", async () => {
    const { prisma, rows, vocabularyReview } = makeDb();
    const res = await gradeVocabularyFor(prisma, ["s1", "s1-other-teacher"], "r1", "good");
    expect(res).toEqual({ ok: true });
    expect(vocabularyReview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1", studentId: { in: ["s1", "s1-other-teacher"] } },
      }),
    );
    expect(rows[0]!.lastReviewedAt).toBeInstanceOf(Date);
  });

  it("another student's review id is not found, and nothing is written", async () => {
    const { prisma, rows, vocabularyReview } = makeDb();
    const res = await gradeVocabularyFor(prisma, ["s1"], "r2", "good");
    expect(res).toEqual({ ok: false, reason: "not-found" });
    expect(vocabularyReview.update).not.toHaveBeenCalled();
    expect(rows[1]!.lastReviewedAt).toBeNull();
  });

  it("does not grade a row whose student is not the one it was read as", async () => {
    const { prisma, rows } = makeDb({ readAnyRow: true });
    const res = await gradeVocabularyFor(prisma, ["s1"], "r2", "easy");
    expect(res).toEqual({ ok: false, reason: "save-failed" });
    expect(rows[1]!.lastReviewedAt).toBeNull();
    expect(rows[1]!.intervalDays).toBe(0);
  });
});
