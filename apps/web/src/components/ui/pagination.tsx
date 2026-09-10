import Link from "next/link";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import type { PageResult } from "@/lib/pagination";

// Server-rendered pagination controls. Like `SortableHead`, links preserve the
// page's other params (filters + sort) and carry only `page`, so paging never
// drops the current view. Renders the "showing X–Y of N" summary always; the
// Prev/Next nav only when there's more than one page.

function pageHref(params: Record<string, string | undefined>, page: number): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && key !== "page") next.set(key, value);
  }
  // Page 1 is the canonical default — keep it out of the URL.
  if (page > 1) next.set("page", String(page));
  const qs = next.toString();
  return qs ? `?${qs}` : "?";
}

// Optional localized label overrides. Default to English so the admin callers
// (operator UI) need pass nothing; the teacher-facing materials page passes
// catalog strings so its pagination reads in the teacher's locale.
export type PaginationLabels = {
  showing?: string;
  of?: string;
  noResults?: string;
  page?: string;
  prev?: string;
  next?: string;
};

export function Pagination({
  state,
  params,
  className,
  labels,
}: {
  state: PageResult;
  params: Record<string, string | undefined>;
  className?: string;
  labels?: PaginationLabels;
}) {
  const { page, totalPages, total, from, to } = state;
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const L = {
    showing: "Showing",
    of: "of",
    noResults: "No results",
    page: "Page",
    prev: "Prev",
    next: "Next",
    ...labels,
  };

  return (
    <nav
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground",
        className,
      )}
      aria-label="Pagination"
    >
      <p>
        {total === 0 ? (
          L.noResults
        ) : (
          <>
            {L.showing} <span className="font-medium text-foreground">{from.toLocaleString()}</span>
            –<span className="font-medium text-foreground">{to.toLocaleString()}</span> {L.of}{" "}
            <span className="font-medium text-foreground">{total.toLocaleString()}</span>
          </>
        )}
      </p>

      {totalPages > 1 ? (
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline">
            {L.page} {page.toLocaleString()} {L.of} {totalPages.toLocaleString()}
          </span>
          {hasPrev ? (
            <Link
              href={pageHref(params, page - 1)}
              scroll={false}
              rel="prev"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              ← {L.prev}
            </Link>
          ) : (
            <span
              aria-disabled
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "pointer-events-none opacity-50",
              )}
            >
              ← {L.prev}
            </span>
          )}
          {hasNext ? (
            <Link
              href={pageHref(params, page + 1)}
              scroll={false}
              rel="next"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              {L.next} →
            </Link>
          ) : (
            <span
              aria-disabled
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "pointer-events-none opacity-50",
              )}
            >
              {L.next} →
            </span>
          )}
        </div>
      ) : null}
    </nav>
  );
}
