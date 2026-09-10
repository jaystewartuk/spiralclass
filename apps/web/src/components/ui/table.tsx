import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { SortDir, SortParams, SortState } from "@/lib/table-sort";

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-x-auto">
      <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("bg-muted/50 [&_tr]:border-b", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot ref={ref} className={cn("bg-muted/50 border-t font-medium", className)} {...props} />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        // `relative` makes the row a positioning context so a `RowLink`'s
        // stretched overlay covers the whole row (see RowLink below).
        "border-border hover:bg-muted/40 data-[state=selected]:bg-muted relative border-t transition-colors",
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, scope = "col", ...props }, ref) => (
  <th
    ref={ref}
    scope={scope}
    className={cn(
      "text-muted-foreground h-10 px-3 text-left align-middle text-xs font-semibold [&:has([role=checkbox])]:pr-0",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn("p-3 align-middle [&:has([role=checkbox])]:pr-0", className)}
    {...props}
  />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("text-muted-foreground mt-4 text-sm", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

/**
 * Framed container for a `Table`. Replaces the ad-hoc
 * `<div className="rounded-md border">` that used to wrap every admin table.
 *
 * On `md+` it draws the rounded border and — crucially — clips with
 * `overflow-hidden` so the header's `bg-muted/50` and the row
 * `hover:bg-muted/40` don't bleed their square corners past the rounded
 * frame. Below `md` the `.table-stack` styles turn each row into its own
 * bordered card, so the outer border is dropped to avoid a redundant
 * double border and the cramped "rows flush against the frame" look.
 */
function TableShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("lg:overflow-hidden lg:rounded-md lg:border", className)}>{children}</div>
  );
}

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  // Active column shows a solid arrow; inactive sortable columns reveal a
  // faint double-arrow on hover/focus so the affordance is discoverable
  // without cluttering every header.
  if (!active) {
    return (
      <span
        aria-hidden
        className="text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        ↕
      </span>
    );
  }
  return (
    <span aria-hidden className="text-foreground">
      {dir === "asc" ? "↑" : "↓"}
    </span>
  );
}

/**
 * Build a `?sort=&dir=` href that preserves the page's filters. `page` is
 * dropped so re-sorting returns to the first page (page 5 of one ordering is
 * meaningless under another).
 */
function sortHref(
  params: Record<string, string | undefined>,
  column: string,
  nextDir: SortDir,
): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && key !== "sort" && key !== "dir" && key !== "page") next.set(key, value);
  }
  next.set("sort", column);
  next.set("dir", nextDir);
  return `?${next.toString()}`;
}

/**
 * A `TableHead` whose label is a link that toggles URL-driven sorting while
 * preserving any active filters. First click sorts ascending; clicking the
 * active column flips direction. Works in Server Components (no client JS).
 */
function SortableHead({
  label,
  column,
  sort,
  params,
  className,
}: {
  label: string;
  column: string;
  sort: SortState;
  /** The page's current `searchParams` (filters are preserved in the link). */
  params: SortParams & Record<string, string | undefined>;
  className?: string;
}) {
  const active = sort.key === column;
  const nextDir: SortDir = active && sort.dir === "asc" ? "desc" : "asc";
  return (
    <TableHead
      className={className}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <Link
        href={sortHref(params, column, nextDir)}
        scroll={false}
        className="group hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded transition-colors focus-visible:ring-3 focus-visible:outline-hidden"
      >
        {label}
        <SortArrow active={active} dir={sort.dir} />
      </Link>
    </TableHead>
  );
}

/**
 * The primary link of a clickable table row. Renders a normal anchor (so
 * keyboard focus, right-click "open in new tab" and cmd/ctrl-click all work)
 * but stretches an invisible `::after` overlay across the whole row, so that
 * tapping anywhere on the row — not just the link text — navigates. Relies on
 * `TableRow` being `position: relative` (its default). Place it on the cell
 * that names the row's entity; the row must not contain other interactive
 * controls, since the overlay would sit on top of them.
 */
function RowLink({ className, ...props }: React.ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline focus-visible:outline-hidden",
        className,
      )}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  TableShell,
  SortableHead,
  SortArrow,
  RowLink,
};
