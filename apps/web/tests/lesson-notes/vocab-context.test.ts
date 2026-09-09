import { describe, expect, it, vi } from "vitest";
import { attachVocabContext } from "@/lib/lesson-notes/vocab-context";

function fakePrisma(insights: unknown[]) {
  return { lessonInsight: { findMany: vi.fn(async () => insights) } };
}

describe("attachVocabContext", () => {
  it("returns an empty array without querying for an empty term list", async () => {
    const prisma = fakePrisma([]);
    expect(await attachVocabContext(prisma as any, [])).toEqual([]);
    expect(prisma.lessonInsight.findMany).not.toHaveBeenCalled();
  });

  it("joins the confirming lesson's evidence + suggestion by normalised term match", async () => {
    const prisma = fakePrisma([
      {
        teacherId: "t1",
        summary: "ubiquitous",
        evidence: "it's ubiquitous here",
        suggestion: "means 'everywhere'",
        createdAt: new Date("2026-07-01"),
        booking: { studentId: "s1" },
      },
    ]);
    const result = await attachVocabContext(prisma as any, [
      { id: "r1", term: "Ubiquitous", teacherId: "t1", studentId: "s1" },
    ]);
    expect(result).toEqual([
      { id: "r1", term: "Ubiquitous", context: "it's ubiquitous here — means 'everywhere'" },
    ]);
  });

  it("returns null context when no matching insight is found", async () => {
    const prisma = fakePrisma([]);
    const result = await attachVocabContext(prisma as any, [
      { id: "r1", term: "serendipity", teacherId: "t1", studentId: "s1" },
    ]);
    expect(result).toEqual([{ id: "r1", term: "serendipity", context: null }]);
  });

  it("keeps only the most recent sighting per (teacher, student, term)", async () => {
    const prisma = fakePrisma([
      {
        teacherId: "t1",
        summary: "run",
        evidence: "newer evidence",
        suggestion: null,
        createdAt: new Date("2026-07-10"),
        booking: { studentId: "s1" },
      },
      {
        teacherId: "t1",
        summary: "run",
        evidence: "older evidence",
        suggestion: null,
        createdAt: new Date("2026-06-01"),
        booking: { studentId: "s1" },
      },
    ]);
    const result = await attachVocabContext(prisma as any, [
      { id: "r1", term: "run", teacherId: "t1", studentId: "s1" },
    ]);
    expect(result[0]!.context).toBe("newer evidence");
  });
});
