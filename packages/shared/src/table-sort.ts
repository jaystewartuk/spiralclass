// Client-side sort for the admin data tables. A table loads a bounded set of
// rows into memory and sorts them in-browser rather than re-querying; the
// columns that must stay correct across pages also have a Prisma-`orderBy`
// server sort (apps/web/src/lib/table-sort.ts), which shares these
// `SortDir`/`SortState` types so the two agree on what a sort is.

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir };

type SortColumn<T> = {
  key: string;
  label: string;
  get: (row: T) => string | number | null | undefined;
};

/**
 * Compare two possibly-null sort values. Nulls always sort last regardless of
 * direction — sorting the whole array then reversing for `desc` would instead
 * flip nulls to the front, which reads as broken to whoever's looking at the
 * grid.
 */
function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  dir: SortDir,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const dirMul = dir === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * dirMul;
  return String(a).localeCompare(String(b)) * dirMul;
}

// Pure and total: an unknown `key` (not in `columns`) falls back to the first
// column rather than throwing, since a stale sort key (e.g. from a previous
// app version, or a page that was reloaded with a URL from an older build)
// shouldn't crash the screen.
export function sortRows<T>(rows: T[], columns: SortColumn<T>[], sort: SortState): T[] {
  const column = columns.find((c) => c.key === sort.key) ?? columns[0];
  if (!column) return rows;
  return [...rows].sort((a, b) => compareValues(column.get(a), column.get(b), sort.dir));
}
