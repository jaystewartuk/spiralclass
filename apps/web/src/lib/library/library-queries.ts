import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Shared read layer for the teacher's reusable material library (bookingId:null
// rows). The offset (RSC page) and cursor (infinite scroll) readers build their
// `where`/`orderBy` here so both filter and sort identically. They used to load
// the entire library and filter in memory; this pushes every filter into the
// query and bounds each fetch to one page, capping the per-row signed-URL
// minting too.
//
// The cursor variant mirrors the inbox pattern (lib/notifications/inbox-queries)
// — `take + 1`, slice, hand back the last id as `nextCursor`.

export type LibraryTypeFilter = "content" | "file" | "link";
export type LibraryVisibilityFilter = "at_or_below" | "exact" | "all";

// Sort keys the WEB (offset) list offers. "name" is safe on offset because
// skip/take doesn't use a keyset — see the cursor note below for why mobile
// can't paginate a nullable `label`.
export type LibrarySort = "recent" | "oldest" | "name";
// Sort keys the MOBILE (cursor) list offers. Restricted to the non-null
// `createdAt` column: Prisma keyset pagination over a nullable leading orderBy
// column (`label`) skips/duplicates rows around the NULL boundary, so mobile
// keeps its "name" sort client-side over already-loaded pages instead.
export type LibraryCursorSort = "recent" | "oldest";

export type LibraryFilters = {
  teacherId: string;
  // The archived list is a separate query from the active one — never mix them
  // in the same page, so the caller states which shelf it wants.
  archived: boolean;
  // A focus-tag category id (Gap G1 taxonomy). Matches items carrying any tag
  // in that category.
  category?: string | null;
  level?: string | null;
  type?: LibraryTypeFilter | null;
  visibility?: LibraryVisibilityFilter | null;
  // Free-text — matches the label OR any focus-tag label (case-insensitive).
  q?: string | null;
};

// The "kind" of a material is derived, not stored: a body wins (native
// content), else a file, else a link. This is the WEB precedence
// (page.tsx / student-view.ts); we standardize on it for the type filter so a
// combined body+file item buckets the same way on every surface.
function typeWhere(type: LibraryTypeFilter): Prisma.LibraryMaterialWhereInput {
  switch (type) {
    case "content":
      return { body: { not: null } };
    case "file":
      return { body: null, storagePath: { not: null } };
    case "link":
      return { body: null, storagePath: null };
  }
}

export function buildLibraryWhere(f: LibraryFilters): Prisma.LibraryMaterialWhereInput {
  const where: Prisma.LibraryMaterialWhereInput = {
    teacherId: f.teacherId,
    // Never drop this — the table is shared with private booking-scoped rows
    // (D-69); this page/endpoint only ever manages the reusable library.
    bookingId: null,
    archived: f.archived,
  };
  if (f.level) where.levelId = f.level;
  if (f.visibility) where.visibility = f.visibility;
  if (f.category) where.focusTags = { some: { focusTag: { categoryId: f.category } } };
  if (f.type) Object.assign(where, typeWhere(f.type));
  const q = f.q?.trim();
  if (q) {
    // AND-ed with the scope filters above (Prisma ANDs top-level keys): match
    // the item's own label OR any of its tag labels. `contains` is an
    // unanchored ILIKE — fine bounded to one teacher's rows, not a global
    // search (no trigram index).
    where.OR = [
      { label: { contains: q, mode: "insensitive" } },
      { focusTags: { some: { focusTag: { label: { contains: q, mode: "insensitive" } } } } },
    ];
  }
  return where;
}

export function librarySortOrderBy(
  sort: LibrarySort,
): Prisma.LibraryMaterialOrderByWithRelationInput[] {
  switch (sort) {
    case "oldest":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "name":
      // Postgres sorts ASC NULLS LAST by default, so unlabeled items trail.
      return [{ label: "asc" }, { id: "asc" }];
    case "recent":
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

export function isLibrarySort(v: unknown): v is LibrarySort {
  return v === "recent" || v === "oldest" || v === "name";
}

// One select shape for both readers — a superset each projects down from.
// `createdAt` drives the default sort; the tag join carries id/label/categoryId
// so a renderer can show chips or map to `focusTagIds`.
export const LIBRARY_LIST_SELECT = {
  id: true,
  levelId: true,
  visibility: true,
  unit: true,
  label: true,
  storagePath: true,
  linkUrl: true,
  body: true,
  contentSource: true,
  archived: true,
  createdAt: true,
  focusTags: {
    select: { focusTag: { select: { id: true, label: true, categoryId: true } } },
  },
} satisfies Prisma.LibraryMaterialSelect;

export type LibraryListRow = Prisma.LibraryMaterialGetPayload<{
  select: typeof LIBRARY_LIST_SELECT;
}>;

// Total matching rows — for the web "showing X–Y of N" summary + page count.
// Runs before the row fetch so the page can be clamped (resolvePage) to a valid
// range before computing `skip`. With the
// [teacherId, bookingId, archived, createdAt] index it's an index-range count
// over one teacher's rows.
export function countLibraryMaterials(
  filters: LibraryFilters,
  db: Pick<PrismaClient, "libraryMaterial"> = prisma,
): Promise<number> {
  return db.libraryMaterial.count({ where: buildLibraryWhere(filters) });
}

// One offset page of rows (web). Pair with countLibraryMaterials + resolvePage:
// count first, clamp the page, then fetch its rows with the resulting skip.
export function listLibraryMaterialsRows(
  filters: LibraryFilters,
  opts: { sort: LibrarySort; skip: number; take: number },
  db: Pick<PrismaClient, "libraryMaterial"> = prisma,
): Promise<LibraryListRow[]> {
  return db.libraryMaterial.findMany({
    where: buildLibraryWhere(filters),
    orderBy: librarySortOrderBy(opts.sort),
    skip: opts.skip,
    take: opts.take,
    select: LIBRARY_LIST_SELECT,
  });
}

// Cursor page (mobile / infinite scroll). `cursor` is the id of the last row
// of the previous page; ordering is a stable `(createdAt, id)` keyset so the
// seek is a `cursor` + `skip:1` query. Fetch one extra row to know whether an
// older page exists.
export async function listLibraryMaterialsCursor(
  filters: LibraryFilters,
  opts: { sort: LibraryCursorSort; take: number; cursor?: string | null },
  db: Pick<PrismaClient, "libraryMaterial"> = prisma,
): Promise<{ rows: LibraryListRow[]; nextCursor: string | null }> {
  const where = buildLibraryWhere(filters);
  const rows = await db.libraryMaterial.findMany({
    where,
    orderBy: librarySortOrderBy(opts.sort),
    take: opts.take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: LIBRARY_LIST_SELECT,
  });
  const hasMore = rows.length > opts.take;
  const pageRows = hasMore ? rows.slice(0, opts.take) : rows;
  const nextCursor = hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null;
  return { rows: pageRows, nextCursor };
}
