// Client-side sort for admin list screens/grids, shared by web and mobile.
// Both platforms load a bounded set of rows into memory and sort them
// in-browser/in-app rather than re-querying — web additionally has a
// Prisma-`orderBy`-driven server sort for the columns that need to stay
// correct across pages (see apps/web/src/lib/table-sort.ts), but the actual
// comparator used for the instant, in-memory reorder is this one, so mobile
// and web agree on tie-breaking/null semantics instead of hand-copying it.

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir };

export type SortColumn<T> = {
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
export function compareValues(
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
