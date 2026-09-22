import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

// Level-gated material library — docs/features/library-materials.md.
//
// Levels are teacher-scoped rows, not a fixed CEFR enum, so non-language
// teachers can run their own ladders (Grade 7/8/9, Beginner/…) without a
// migration. Every teacher is seeded with the six CEFR levels; this file is
// the single source of truth for that seed and for the "level and below"
// visibility rule that the browse surface enforces.

export const CEFR_LEVELS = [
  { code: "a1", label: "A1", position: 1 },
  { code: "a2", label: "A2", position: 2 },
  { code: "b1", label: "B1", position: 3 },
  { code: "b2", label: "B2", position: 4 },
  { code: "c1", label: "C1", position: 5 },
  { code: "c2", label: "C2", position: 6 },
] as const;

export type LevelRow = {
  id: string;
  code: string;
  label: string;
  position: number;
};

type Db = PrismaClient | Prisma.TransactionClient;

// Idempotent: relies on the unique (teacher_id, code) index. Safe to call on
// every read — `skipDuplicates` makes the second call a no-op. The migration
// backfills existing teachers; this covers anyone created afterwards.
export async function ensureTeacherLevels(
  teacherId: string,
  db: Db = defaultPrisma,
): Promise<void> {
  await db.level.createMany({
    data: CEFR_LEVELS.map((l) => ({ teacherId, ...l })),
    skipDuplicates: true,
  });
}

// Returns the teacher's active levels ordered low → high. Self-heals: if a
// teacher somehow has none (created between migration and deploy), it seeds
// them once and re-reads.
export async function getTeacherLevels(
  teacherId: string,
  db: Db = defaultPrisma,
): Promise<LevelRow[]> {
  const select = { id: true, code: true, label: true, position: true } as const;
  const where = { teacherId, archived: false } as const;
  let levels = await db.level.findMany({ where, select, orderBy: { position: "asc" } });
  if (levels.length === 0) {
    await ensureTeacherLevels(teacherId, db);
    levels = await db.level.findMany({ where, select, orderBy: { position: "asc" } });
  }
  return levels;
}

// Resolves a student's level into the set of level ids each visibility mode
// should match. `at_or_below` matches their level and every lower one; `exact`
// matches only their level; `all` matches regardless (handled in the where
// builder). A null/unrecognized student level → { atOrBelowIds: [], exactId:
// null }; the where builder treats that as "no browsable library at all" (see
// libraryBrowseWhere).
export function visibleLevelIds(
  levels: LevelRow[],
  studentLevelId: string | null | undefined,
): { atOrBelowIds: string[]; exactId: string | null } {
  const student = studentLevelId ? levels.find((l) => l.id === studentLevelId) : undefined;
  if (!student) return { atOrBelowIds: [], exactId: null };
  return {
    atOrBelowIds: levels.filter((l) => l.position <= student.position).map((l) => l.id),
    exactId: student.id,
  };
}

// Prisma `where` for the items a student may BROWSE (does not include items
// assigned to them directly — those are fetched separately and shown
// regardless of level). Archived items are always excluded.
export function libraryBrowseWhere(
  teacherId: string,
  levels: LevelRow[],
  studentLevelId: string | null | undefined,
): Prisma.LibraryMaterialWhereInput {
  const { atOrBelowIds, exactId } = visibleLevelIds(levels, studentLevelId);
  // Post-D-69: LibraryMaterial also holds booking-scoped rows (bookingId set)
  // — a class's private scheduled materials/content. Those are never part of
  // the level-gated browse surface, so exclude them explicitly rather than
  // relying on their visibility always being "at_or_below" in practice.
  const base = { teacherId, archived: false, bookingId: null } as const;
  // Product rule (2026-07): a student with no level set sees NO browsable
  // library — not even `all`-visibility items. The only materials that reach a
  // level-less student are the ones a teacher explicitly put in front of them
  // (a notebook assignment or a class attachment), and those are fetched
  // outside this level-gated query. So an unset level matches nothing here.
  if (!exactId) {
    return { ...base, id: { in: [] } };
  }
  // Level set: `all` items (regardless), plus this level and everything below,
  // plus their exact level.
  return {
    ...base,
    OR: [
      { visibility: "all" },
      { visibility: "at_or_below", levelId: { in: atOrBelowIds } },
      { visibility: "exact", levelId: exactId },
    ],
  };
}
