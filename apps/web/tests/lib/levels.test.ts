import { describe, expect, it } from "vitest";
import { CEFR_LEVELS, libraryBrowseWhere, visibleLevelIds, type LevelRow } from "@/lib/levels";

// CEFR ladder a1..c2 as Level rows, with stable fake ids = the code.
const LEVELS: LevelRow[] = CEFR_LEVELS.map((l) => ({ id: l.code, ...l }));

const id = (code: string) => code; // ids are the codes in this fixture

describe("visibleLevelIds", () => {
  it("at-or-below includes the student's level and every lower one", () => {
    const { atOrBelowIds, exactId } = visibleLevelIds(LEVELS, id("b1"));
    expect(atOrBelowIds.sort()).toEqual(["a1", "a2", "b1"]);
    expect(exactId).toBe("b1");
  });

  it("never includes a higher level (the hard ceiling)", () => {
    const { atOrBelowIds } = visibleLevelIds(LEVELS, id("a2"));
    expect(atOrBelowIds).not.toContain("b1");
    expect(atOrBelowIds).not.toContain("c2");
    expect(atOrBelowIds.sort()).toEqual(["a1", "a2"]);
  });

  it("a null student level resolves to nothing (empty ids, no exact)", () => {
    expect(visibleLevelIds(LEVELS, null)).toEqual({ atOrBelowIds: [], exactId: null });
    expect(visibleLevelIds(LEVELS, undefined)).toEqual({ atOrBelowIds: [], exactId: null });
  });

  it("an unknown level id is treated as no level", () => {
    expect(visibleLevelIds(LEVELS, "does-not-exist")).toEqual({
      atOrBelowIds: [],
      exactId: null,
    });
  });
});

describe("libraryBrowseWhere", () => {
  it("scopes to the teacher, excludes archived, and ORs the three visibility modes", () => {
    const where = libraryBrowseWhere("teacher-1", LEVELS, id("a2"));
    expect(where.teacherId).toBe("teacher-1");
    expect(where.archived).toBe(false);
    expect(where.OR).toEqual([
      { visibility: "all" },
      { visibility: "at_or_below", levelId: { in: ["a1", "a2"] } },
      { visibility: "exact", levelId: "a2" },
    ]);
  });

  it("a student with no level sees NO browsable library (not even `all` items)", () => {
    // Product rule (2026-07): an unset level surfaces nothing browsable — only
    // explicit teacher assignments/attachments (fetched elsewhere) reach them.
    const where = libraryBrowseWhere("teacher-1", LEVELS, null);
    expect(where.OR).toBeUndefined();
    expect((where as { id?: { in: string[] } }).id).toEqual({ in: [] });
    // Still scoped/guarded like the level-set path.
    expect(where.teacherId).toBe("teacher-1");
    expect(where.archived).toBe(false);
    expect(where.bookingId).toBeNull();
  });

  it("a c2 student sees the whole ladder via at_or_below", () => {
    const where = libraryBrowseWhere("teacher-1", LEVELS, id("c2"));
    const atOrBelow = (where.OR as { visibility: string; levelId?: { in: string[] } }[]).find(
      (c) => c.visibility === "at_or_below",
    );
    expect(atOrBelow?.levelId?.in).toEqual(["a1", "a2", "b1", "b2", "c1", "c2"]);
  });
});
