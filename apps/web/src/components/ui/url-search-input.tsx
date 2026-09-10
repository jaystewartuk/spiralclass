"use client";

import { useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

// A search box that lives in the URL: it writes `?q=` (or another param) and
// lets the server re-render the filtered list. Debounced in the change handler
// rather than a useEffect, so typing stays responsive without a round-trip per
// keystroke, and `router.replace` keeps it a soft navigation — the field never
// remounts and focus is never lost mid-word.
//
// Extracted from the teacher library's own search (dashboard/materials), which
// was the only implementation until the student shelf needed the same control.
// Two copies of a debounce, a param write and a scroll flag is exactly the kind
// of thing that drifts, so there is one.

const DEBOUNCE_MS = 300;

export function UrlSearchInput({
  param = "q",
  clearParams,
  placeholder,
  label,
  className,
}: {
  /** Query param this field owns. */
  param?: string;
  /**
   * Params dropped whenever the query changes — a new search invalidates a
   * page window or a scroll position that was computed for the old one.
   */
  clearParams?: string[];
  placeholder: string;
  /**
   * Accessible name. Defaults to the placeholder, which is the right answer
   * when the placeholder already reads as a label ("Search your materials")
   * and the wrong one when it reads as an example.
   */
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(params.get(param) ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onChange(next: string) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const p = new URLSearchParams(params.toString());
      const q = next.trim();
      if (q) p.set(param, q);
      else p.delete(param);
      for (const name of clearParams ?? []) p.delete(name);
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, DEBOUNCE_MS);
  }

  return (
    <div className={className}>
      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={label ?? placeholder}
          className="pl-9"
        />
      </div>
    </div>
  );
}
