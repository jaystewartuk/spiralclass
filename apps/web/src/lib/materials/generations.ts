import type { MaterialGenerationKind, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// What the model wrote for a teacher's materials, and what she did with it
// (D-202). Every successful materials call writes one ClassContentGeneration
// row — the monthly cap counts them — and that row now carries the verdict
// too: the output, the refine instruction that produced it, and `keptAt` once
// a save contained it.
//
// Production showed why it has to be recorded here (2026-10-16): the one real
// teacher ran about 110 generations and refines over three months, kept 13
// materials, and never once hand-edited the model's text. Her verdict is the
// refine button and the walk-away, and neither left a trace. This is the
// trace, and it is what a materials eval set is built from.

// Generated text is kept this long, then cleared. Long enough to gather a
// month of real use into eval cases; short enough that a draft she threw
// away does not outlive its usefulness.
export const GENERATION_BODY_RETENTION_DAYS = 30;

// How far back a save looks for the generation it contains. A teacher
// generates, refines and saves in one sitting; a day covers a sitting that
// was left open overnight without matching a draft from last week.
export const KEEP_MATCH_WINDOW_HOURS = 24;

export async function recordMaterialGeneration(input: {
  teacherId: string;
  kind: MaterialGenerationKind;
  // The output as the teacher received it. Null for a podcast script, which
  // she hears rather than edits.
  body?: string | null;
  instruction?: string | null;
}): Promise<void> {
  await prisma.classContentGeneration.create({
    data: {
      teacherId: input.teacherId,
      kind: input.kind,
      body: input.body?.trim() || null,
      instruction: input.instruction?.trim() || null,
    },
  });
}

// Pure: does a saved body contain a generation's output? Whole-document
// generate and refine replace the body, and a per-section refine splices its
// output into it, so containment covers both. Line endings are normalised
// because the editor and the model disagree about them.
export function savedBodyContains(savedBody: string, generated: string): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
  const g = norm(generated);
  return g.length > 0 && norm(savedBody).includes(g);
}

// Called by the save paths when the body being saved is AI-sourced. Marks
// every recent, unkept generation of this teacher's that the saved body
// contains. A teacher typing into the text flips the source to manual, so
// that save never reaches here and her own words are never credited to the
// model. Best-effort: a failure here must never fail her save.
export async function markKeptGenerations(input: {
  teacherId: string;
  materialId: string;
  savedBody: string;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - KEEP_MATCH_WINDOW_HOURS * 3_600_000);
  try {
    const candidates = await prisma.classContentGeneration.findMany({
      where: {
        teacherId: input.teacherId,
        keptAt: null,
        body: { not: null },
        createdAt: { gte: since },
      },
      select: { id: true, body: true },
    });
    const ids = candidates
      .filter((c) => c.body != null && savedBodyContains(input.savedBody, c.body))
      .map((c) => c.id);
    if (ids.length === 0) return 0;
    const res = await prisma.classContentGeneration.updateMany({
      where: { id: { in: ids }, teacherId: input.teacherId },
      data: { keptAt: now, materialId: input.materialId },
    });
    return res.count;
  } catch {
    return 0;
  }
}

// Daily: clear the text of generations past retention. The row stays — the
// cap counts it, and kind and keptAt are the figure that outlives the text.
export async function purgeExpiredGenerationBodies(
  db: Pick<PrismaClient, "classContentGeneration">,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - GENERATION_BODY_RETENTION_DAYS * 86_400_000);
  // tenancy-exempt: retention sweep across every teacher, clears text only (D-202)
  const res = await db.classContentGeneration.updateMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [{ body: { not: null } }, { instruction: { not: null } }],
    },
    data: { body: null, instruction: null },
  });
  return res.count;
}
