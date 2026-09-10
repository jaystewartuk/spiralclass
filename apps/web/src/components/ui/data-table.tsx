"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";
import { sortRows, type SortDir, type SortState } from "@spiralclass/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SortArrow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type { ColumnDef, SortDir, SortState };

export type AdminColumnMeta = {
  /**
   * Doubles as the header text, the mobile `.table-stack` `data-label`, and
   * (when `sortable`) the accessible name of the sort button — one string
   * instead of three copies to keep in sync.
   */
  label: string;
  /**
   * Sorts the currently-loaded rows instantly, client-side, with zero
   * network calls — this is what makes every column sortable, including ones
   * with no sensible Prisma `orderBy` (e.g. a derived Stripe-status column).
   * `onSortChange` in `DataTable` decides separately whether a given column
   * should *also* sync to the URL for cross-page correctness.
   */
  sortable?: boolean;
  className?: string;
};

// Module augmentation is tanstack's documented way to type `column.meta` —
// without it, `columnDef.meta` is typed as the library's empty base
// interface everywhere it's read (header/cell renderers included).
declare module "@tanstack/react-table" {
  // Declaration merging requires an interface body even though it adds no
  // members of its own — it exists purely to extend the library's type.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> extends AdminColumnMeta {}
}

/** An admin grid column: a real tanstack `ColumnDef`. Give every sortable
 * column an explicit `id` — it's what ties the header button,
 * `SortState.key`, and the mobile `data-label` together. */
export type AdminColumnDef<T> = ColumnDef<T, unknown>;

type WithAccessorFn<T> = { accessorFn?: (row: T, index: number) => unknown };

/**
 * Generic, headless-table-powered admin grid. Wraps `@tanstack/react-table`
 * purely for its column-definition/header/cell-rendering contract — sorting
 * itself is applied by the caller via the shared `sortRows` comparator
 * (`@spiralclass/shared`) rather than tanstack's
 * built-in sorted-row-model, since that model naively negates the comparator
 * for `desc`, which would flip null values to the front instead of always
 * sorting them last. Renders through the existing shadcn-style `Table`
 * primitives, so it's visually identical to the hand-rolled tables it
 * replaces.
 */
export function DataTable<T>({
  columns,
  data,
  sort,
  onSortChange,
  getRowId,
  getRowClassName,
  className,
}: {
  columns: AdminColumnDef<T>[];
  /** Rows already filtered — sorting is applied here, filtering is the
   * caller's responsibility (predicates vary too much per page to generalize
   * usefully). */
  data: T[];
  sort: SortState;
  onSortChange: (next: SortState) => void;
  getRowId?: (row: T, index: number) => string;
  /** Optional per-row className (e.g. `align-top` for rows with multi-line cells). */
  getRowClassName?: (row: T) => string | undefined;
  className?: string;
}) {
  const sortedData = React.useMemo(() => {
    const sortCols = columns
      .filter((c): c is AdminColumnDef<T> & { id: string } => !!c.meta?.sortable && !!c.id)
      .map((c) => {
        const accessorFn = (c as WithAccessorFn<T>).accessorFn;
        return {
          key: c.id,
          label: c.meta!.label,
          get: (row: T) =>
            accessorFn ? (accessorFn(row, 0) as string | number | null | undefined) : undefined,
        };
      });
    if (!sortCols.length) return data;
    return sortRows(data, sortCols, sort);
  }, [data, columns, sort]);

  const table = useReactTable({
    data: sortedData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId,
  });

  return (
    <Table className={cn("table-stack", className)}>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const meta = header.column.columnDef.meta;
              const isSortable = !!meta?.sortable;
              const active = sort.key === header.column.id;
              const nextDir: SortDir = active && sort.dir === "asc" ? "desc" : "asc";
              return (
                <TableHead
                  key={header.id}
                  className={meta?.className}
                  aria-sort={
                    isSortable
                      ? active
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                >
                  {header.isPlaceholder ? null : isSortable ? (
                    <button
                      type="button"
                      onClick={() => onSortChange({ key: header.column.id, dir: nextDir })}
                      className="group hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded transition-colors focus-visible:ring-3 focus-visible:outline-none"
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <SortArrow active={active} dir={sort.dir} />
                    </button>
                  ) : (
                    flexRender(header.column.columnDef.header, header.getContext())
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id} className={getRowClassName?.(row.original)}>
            {row.getVisibleCells().map((cell) => {
              const meta = cell.column.columnDef.meta;
              return (
                <TableCell key={cell.id} data-label={meta?.label} className={meta?.className}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
