"use client";

import { useCallback, useState } from "react";

// Pairs with the "always-enabled, validate on submit" form pattern: keep the
// submit button enabled except while pending, run validation in the submit
// handler, and store per-field messages here to render next to each input
// instead of gating the button on a computed validity flag.
export function useFieldErrors<K extends string>() {
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({});

  // Stable, because callers list it in effect deps (`[canGenerate, clearError]`).
  // A fresh function every render re-ran those effects after every keystroke,
  // and each run scheduled a no-op update that React counts as a nested one:
  // ~50 keystrokes arriving back to back threw "Maximum update depth exceeded"
  // and dropped the keystroke that tripped it.
  const clearError = useCallback((key: K) => {
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }, []);

  return { errors, setErrors, clearError } as const;
}
