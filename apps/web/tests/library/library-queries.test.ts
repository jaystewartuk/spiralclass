import { describe, expect, it, vi } from "vitest";
import {
  buildLibraryWhere,
  countLibraryMaterials,
  isLibrarySort,
  librarySortOrderBy,
  listLibraryMaterialsCursor,
  listLibraryMaterialsRows,
  type LibraryFilters,
} from "@/lib/library/library-queries";

const base: LibraryFilters = { teacherId: "t1", archived: false };

describe("buildLibraryWhere", () => {
  it("always scopes to the teacher's reusable, non-archived rows", () => {
    expect(buildLibraryWhere(base)).toEqual({
      teacherId: "t1",
      bookingId: null,
      archived: false,
    });
  });

  it("carries the archived shelf flag", () => {
    expect(buildLibraryWhere({ ...base, archived: true }).archived).toBe(true);
  });

  it("adds equality filters for level + visibility", () => {
    const where = buildLibraryWhere({ ...base, level: "b1", visibility: "exact" });
    expect(where.levelId).toBe("b1");
    expect(where.visibility).toBe("exact");
  });

  it("filters category by any focus tag in that category", () => {
    const where = buildLibraryWhere({ ...base, category: "grammar" });
    expect(where.focusTags).toEqual({ some: { focusTag: { categoryId: "grammar" } } });
  });

  it("derives the type filter with body > file > link precedence", () => {
    expect(buildLibraryWhere({ ...base, type: "content" })).toMatchObject({ body: { not: null } });
    expect(buildLibraryWhere({ ...base, type: "file" })).toMatchObject({
      body: null,
      storagePath: { not: null },
    });
    expect(buildLibraryWhere({ ...base, type: "link" })).toMatchObject({
      body: null,
      storagePath: null,
    });
  });

  it("searches label OR any tag label, case-insensitively, AND-ed with scope", () => {
    const where = buildLibraryWhere({ ...base, q: "  Ser  " });
    expect(where.OR).toEqual([
      { label: { contains: "Ser", mode: "insensitive" } },
      { focusTags: { some: { focusTag: { label: { contains: "Ser", mode: "insensitive" } } } } },
    ]);
    // Scope keys remain — Prisma ANDs top-level keys with the OR.
    expect(where.teacherId).toBe("t1");
    expect(where.bookingId).toBeNull();
  });

  it("ignores blank/whitespace-only search", () => {
    expect(buildLibraryWhere({ ...base, q: "   " }).OR).toBeUndefined();
  });
});

describe("librarySortOrderBy", () => {
  it("defaults to newest-first with a stable id tiebreak", () => {
    expect(librarySortOrderBy("recent")).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });
  it("supports oldest and name", () => {
    expect(librarySortOrderBy("oldest")).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(librarySortOrderBy("name")).toEqual([{ label: "asc" }, { id: "asc" }]);
  });
});

describe("isLibrarySort", () => {
  it("accepts only the known sort keys", () => {
    expect(isLibrarySort("recent")).toBe(true);
    expect(isLibrarySort("oldest")).toBe(true);
    expect(isLibrarySort("name")).toBe(true);
    expect(isLibrarySort("nope")).toBe(false);
    expect(isLibrarySort(undefined)).toBe(false);
  });
});

// Minimal fake matching the Pick<PrismaClient, "libraryMaterial"> the query
// functions accept, so we can assert the args passed to Prisma and the
// cursor-slicing logic without a database.
function fakeDb(rows: { id: string }[], total = rows.length) {
  const findMany = vi.fn(async (_args: Record<string, unknown>) => rows);
  const count = vi.fn(async (_args: Record<string, unknown>) => total);
  return {
    db: { libraryMaterial: { findMany, count } } as never,
    findMany,
    count,
  };
}

describe("countLibraryMaterials", () => {
  it("counts on the built where", async () => {
    const { db, count } = fakeDb([], 42);
    const n = await countLibraryMaterials({ ...base, level: "b1" }, db);
    expect(n).toBe(42);
    expect(count).toHaveBeenCalledWith({ where: buildLibraryWhere({ ...base, level: "b1" }) });
  });
});

describe("listLibraryMaterialsRows", () => {
  it("passes skip/take + the sort order to findMany", async () => {
    const { db, findMany } = fakeDb([{ id: "a" }, { id: "b" }]);
    const rows = await listLibraryMaterialsRows(base, { sort: "name", skip: 24, take: 24 }, db);
    expect(rows).toHaveLength(2);
    const arg = findMany.mock.calls[0]?.[0];
    expect(arg?.skip).toBe(24);
    expect(arg?.take).toBe(24);
    expect(arg?.orderBy).toEqual([{ label: "asc" }, { id: "asc" }]);
  });
});

describe("listLibraryMaterialsCursor", () => {
  it("returns nextCursor when a full extra row comes back", async () => {
    // take=2 → fetch 3; the 3rd signals there's another page.
    const { db, findMany } = fakeDb([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const { rows, nextCursor } = await listLibraryMaterialsCursor(
      base,
      { sort: "recent", take: 2 },
      db,
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(nextCursor).toBe("b");
    // Requests take+1 and no cursor/skip on the first page.
    const arg = findMany.mock.calls[0]?.[0];
    expect(arg?.take).toBe(3);
    expect(arg?.cursor).toBeUndefined();
    expect(arg?.skip).toBeUndefined();
  });

  it("returns a null cursor at the end of the list", async () => {
    const { db } = fakeDb([{ id: "a" }, { id: "b" }]);
    const { rows, nextCursor } = await listLibraryMaterialsCursor(
      base,
      { sort: "recent", take: 2 },
      db,
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(nextCursor).toBeNull();
  });

  it("seeks past a cursor with skip:1", async () => {
    const { db, findMany } = fakeDb([{ id: "c" }, { id: "d" }]);
    await listLibraryMaterialsCursor(base, { sort: "recent", take: 5, cursor: "b" }, db);
    const arg = findMany.mock.calls[0]?.[0];
    expect(arg?.cursor).toEqual({ id: "b" });
    expect(arg?.skip).toBe(1);
  });
});
