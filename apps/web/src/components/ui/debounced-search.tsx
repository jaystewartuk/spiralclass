"use client";

import { Input, type InputProps } from "@/components/ui/input";
import { useDebouncedSubmit } from "@/lib/use-debounced-submit";

const DEFAULT_DELAY_MS = 400;

// A drop-in replacement for the bare `<Input name="q">` search field every
// admin FilterBar uses. Auto-submits the enclosing form a moment after the
// user stops typing, so search feels live without turning the page into a
// client-fetch UI: it's still a plain GET on a real <form>, still bookmarkable,
// still works with JS disabled (falls back to the existing Apply button).
export function DebouncedSearchInput({
  delayMs = DEFAULT_DELAY_MS,
  onChange,
  ...props
}: InputProps & { delayMs?: number }) {
  const scheduleSubmit = useDebouncedSubmit(delayMs);

  return (
    <Input
      {...props}
      onChange={(e) => {
        onChange?.(e);
        scheduleSubmit(e.currentTarget.form);
      }}
    />
  );
}
