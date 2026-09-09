"use client";

import { useCallback, useRef } from "react";

const DEFAULT_DELAY_MS = 400;

// Shared by every admin filter control (text input, select, …): debounce-
// submits the enclosing <form> a moment after being called, so a filter feels
// live (auto-applies, no "Apply" click) without turning the page into a
// client-fetch UI — it's still a plain GET on a real <form>, still
// bookmarkable, still works with JS disabled (falls back to the page's Apply
// button). Extracted out of `DebouncedSearchInput` so selects can reuse the
// exact same debounce-and-submit behavior instead of hand-copying it.
export function useDebouncedSubmit(delayMs: number = DEFAULT_DELAY_MS) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (form: HTMLFormElement | null | undefined) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        form?.requestSubmit();
      }, delayMs);
    },
    [delayMs],
  );
}
