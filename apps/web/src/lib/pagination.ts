// URL-driven offset pagination for the server-rendered admin lists.
//
// Pairs with `table-sort.ts`: both read untrusted query params and hand the
// page back a safe, clamped result plus the state needed to render controls.
// Offset pagination (rather than cursor) is the right fit here — the admin
// tables already compute a filtered `count` for their headers, the sort column
// is arbitrary and user-chosen (which cursors handle poorly), and operators
// need to jump to a specific page, not scroll forever.

export type PageParams = { page?: string };

export type PageResult = {
  /** 1-based current page, clamped to [1, totalPages]. */
  page: number;
  pageSize: number;
  /** Prisma `skip` for the current page. */
  skip: number;
  /** Prisma `take` (equals pageSize). */
  take: number;
  totalPages: number;
  total: number;
  /** 1-based index of the first row shown (0 when empty). */
  from: number;
  /** 1-based index of the last row shown (0 when empty). */
  to: number;
};

/**
 * Resolve an untrusted `?page=` param against a known `total` and page size.
 * Out-of-range, non-numeric, and negative values all collapse to a valid page,
 * so `skip`/`take` are always safe to pass straight to Prisma.
 */
export function resolvePage(params: PageParams, total: number, pageSize: number): PageResult {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const raw = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), totalPages) : 1;
  const skip = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    skip,
    take: pageSize,
    totalPages,
    total,
    from: total === 0 ? 0 : skip + 1,
    to: Math.min(skip + pageSize, total),
  };
}
