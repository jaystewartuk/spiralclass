"use client";

import { useState } from "react";

// Pairs with the "always-enabled, validate on submit" form pattern: keep the
// submit button enabled except while pending, run validation in the submit
// handler, and store per-field messages here to render next to each input
// instead of gating the button on a computed validity flag.
export function useFieldErrors<K extends string>() {
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({});

  function clearError(key: K) {
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  return { errors, setErrors, clearError } as const;
}
