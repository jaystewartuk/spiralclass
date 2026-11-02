import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const recompute = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("./profile", () => ({
  recomputeStudentProfile: (...args: unknown[]) => recompute(...args),
}));

const { addInsightFor } = await import("./insight-actions");

// The write path behind the in-call quick note (components/video/
// call-quick-note.tsx) and the class page's "add your own finding": a note the
// teacher types is a CONFIRMED teacher-source focus area on her own booking,
// and it reaches the student's profile through the recompute.
function fakePrisma(booking: { id: string; studentId: string } | null) {
  const create = vi.fn(async () => ({ id: "i1" }));
  const findFirst = vi.fn(async () => booking);
  const prisma = {
    booking: { findFirst },
    lessonInsight: { create },
  } as unknown as PrismaClient;
  return { prisma, create, findFirst };
}

beforeEach(() => recompute.mockClear());

describe("addInsightFor (the quick note's write path)", () => {
  it("saves a confirmed teacher-source focus area and recomputes the profile", async () => {
    const { prisma, create, findFirst } = fakePrisma({ id: "b1", studentId: "s1" });
    const res = await addInsightFor(prisma, "t1", "b1", {
      category: "grammar",
      summary: "practise the subjunctive next class",
    });
    expect(res).toEqual({ ok: true, bookingId: "b1", studentId: "s1" });
    // Scoped to the calling teacher's own booking.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b1", teacherId: "t1" } }),
    );
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({
      bookingId: "b1",
      teacherId: "t1",
      category: "grammar",
      source: "teacher",
      skill: "subjunctive",
    });
    expect(data.confirmedAt).toBeInstanceOf(Date);
    expect(recompute).toHaveBeenCalledWith(prisma, { teacherId: "t1", studentId: "s1" });
  });

  it("keeps a skill the teacher typed instead of guessing one", async () => {
    const { prisma, create } = fakePrisma({ id: "b1", studentId: "s1" });
    await addInsightFor(prisma, "t1", "b1", {
      category: "vocabulary",
      summary: "food words",
      skill: "  kitchen  ",
    });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.skill).toBe("kitchen");
  });

  it("writes nothing for a booking the teacher does not own", async () => {
    const { prisma, create } = fakePrisma(null);
    const res = await addInsightFor(prisma, "t2", "b1", { category: "grammar", summary: "x" });
    expect(res).toEqual({ ok: false, reason: "not-found" });
    expect(create).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
  });

  it("rejects an empty note before any write", async () => {
    const { prisma, create } = fakePrisma({ id: "b1", studentId: "s1" });
    const res = await addInsightFor(prisma, "t1", "b1", { category: "grammar", summary: "   " });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(create).not.toHaveBeenCalled();
  });
});
