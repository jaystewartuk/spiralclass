// URL-driven, injection-safe sorting for server-rendered admin tables.
//
// Admin list pages are React Server Components that read `searchParams` and
// hand a Prisma `orderBy` straight to the database. We never want the raw
// `?sort=` value to reach Prisma, so every page declares a whitelist of
// sortable columns (`SortColumns`) mapping a stable key to the `orderBy`
// fragment it produces. Unknown or missing keys collapse to the page default,
// which keeps the URL space tidy and the query safe.

export type SortDir = "asc" | "desc";

export type SortState = { key: string; dir: SortDir };

/**
 * A whitelist of sortable columns. Each entry returns the Prisma `orderBy`
 * fragment (object or array) for the requested direction, so relation and
 * compound sorts are expressed once, next to the column they belong to.
 */
export type SortColumns<O> = Record<string, (dir: SortDir) => O>;

/** Raw, untrusted sort inputs as they arrive from the query string. */
export type SortParams = { sort?: string; dir?: string };

/**
 * Resolve untrusted `?sort=&dir=` params against a column whitelist.
 *
 * Returns both the `SortState` (for rendering active column indicators) and
 * the concrete Prisma `orderBy` to feed `findMany`. Falls back to
 * `fallbackKey`/`fallbackDir` whenever the requested column isn't allowed.
 */
export function resolveSort<O>(
  params: SortParams,
  columns: SortColumns<O>,
  fallbackKey: string,
  fallbackDir: SortDir = "desc",
): { state: SortState; orderBy: O } {
  const key =
    params.sort && Object.prototype.hasOwnProperty.call(columns, params.sort)
      ? params.sort
      : fallbackKey;
  const dir: SortDir = params.dir === "asc" ? "asc" : params.dir === "desc" ? "desc" : fallbackDir;
  return { state: { key, dir }, orderBy: columns[key](dir) };
}
