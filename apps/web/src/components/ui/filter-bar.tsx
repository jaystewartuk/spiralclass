"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useDebouncedSubmit } from "@/lib/use-debounced-submit";
import { cn } from "@/lib/utils";

// Shared scaffolding for the admin list filter forms. Before this, every list
// page hand-rolled the same `<form className="grid ... rounded-md border
// bg-muted/30 p-4">` shell, the same bare `<select className="h-9 w-full ...">`,
// and the same Apply/Reset footer. `FilterBar` + `FilterField` + `FilterSelect`
// own that markup once so pages only declare their fields.
//
// Static maps (rather than interpolated class names) keep Tailwind's JIT able
// to see every utility at build time.

const GRID_COLS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
};

const COL_SPAN: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
  5: "lg:col-span-5",
  6: "lg:col-span-6",
};

export const FilterBar = React.forwardRef<
  HTMLFormElement,
  {
    /** Number of grid columns on `md+`. */
    columns?: number;
    /** Href the Reset button clears to (the unfiltered page). */
    resetHref: string;
    /** Optional explicit form action (defaults to same-page GET). */
    action?: string;
    applyLabel?: string;
    resetLabel?: string;
    /**
     * Extra params to carry through on submit as hidden inputs — typically the
     * active `sort`/`dir` so filtering doesn't reset the chosen column order.
     */
    hidden?: Record<string, string | undefined>;
    children: React.ReactNode;
  }
>(function FilterBar(
  { columns = 4, resetHref, action, applyLabel = "Apply", resetLabel = "Reset", hidden, children },
  ref,
) {
  return (
    <form
      ref={ref}
      action={action}
      className={cn("bg-muted/30 grid gap-3 rounded-md border p-4", GRID_COLS[columns])}
    >
      {children}
      {hidden
        ? Object.entries(hidden).map(([name, value]) =>
            value ? <input key={name} type="hidden" name={name} value={value} /> : null,
          )
        : null}
      <div className={cn("flex items-end gap-2", COL_SPAN[columns])}>
        <Button type="submit" size="sm">
          {applyLabel}
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href={resetHref}>{resetLabel}</Link>
        </Button>
      </div>
    </form>
  );
});

export function FilterField({
  label,
  span = 1,
  children,
}: {
  label: string;
  /** How many grid columns the field spans on `md+`. */
  span?: number;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("space-y-1 text-xs", COL_SPAN[span])}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function FilterSelect({
  label,
  name,
  defaultValue,
  value,
  onValueChange,
  options,
  span = 1,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  /**
   * Controlled value — when provided together with `onValueChange`, the
   * select becomes a live-updating control: changing it fires
   * `onValueChange` instantly (for client-side filtering of already-loaded
   * rows) and auto-submits the enclosing form in the background, so the page
   * no longer needs a manual Apply click. Omit both for the original
   * uncontrolled `defaultValue` behavior.
   */
  value?: string;
  onValueChange?: (value: string) => void;
  options: { value: string; label: string }[];
  span?: number;
}) {
  const scheduleSubmit = useDebouncedSubmit(0);
  const live = value !== undefined && onValueChange !== undefined;

  return (
    <FilterField label={label} span={span}>
      <select
        name={name}
        {...(live
          ? {
              value,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                onValueChange!(e.target.value);
                scheduleSubmit(e.currentTarget.form);
              },
            }
          : { defaultValue: defaultValue ?? "" })}
        className="bg-background h-9 w-full rounded-md border px-2 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FilterField>
  );
}
