"use client";

import { useState, type KeyboardEvent } from "react";

// Shared keyboard-navigation primitive for any "type, see a list, arrow
// through it, Enter to pick" control — the admin nav-bar quick search and
// `components/ui/combobox.tsx` both build on this, and it's meant to be
// reused for any future typeahead/listbox on the site rather than
// hand-rolling the index math again.

/**
 * Pure index-stepping for a keyboard-navigable list. Clamps at the bounds
 * rather than wrapping (matches the pre-existing `combobox.tsx` behavior).
 * Returns a safe in-range index for a non-navigation key or an empty list.
 */
export function stepActiveIndex(current: number, key: string, itemCount: number): number {
  if (itemCount <= 0) return 0;
  switch (key) {
    case "ArrowDown":
      return Math.min(current + 1, itemCount - 1);
    case "ArrowUp":
      return Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return itemCount - 1;
    default:
      return Math.min(Math.max(current, 0), itemCount - 1);
  }
}

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

export function useListKeyboardNav({
  itemCount,
  onCommit,
  onClose,
}: {
  itemCount: number;
  /** Called with the active index on Enter, only when the list is non-empty. */
  onCommit: (index: number) => void;
  onClose: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);

  function onKeyDown(e: KeyboardEvent) {
    if (NAV_KEYS.has(e.key)) {
      e.preventDefault();
      setActiveIndex((i) => stepActiveIndex(i, e.key, itemCount));
    } else if (e.key === "Enter") {
      if (itemCount <= 0) return;
      e.preventDefault();
      onCommit(stepActiveIndex(activeIndex, "", itemCount));
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return { activeIndex, setActiveIndex, onKeyDown };
}
