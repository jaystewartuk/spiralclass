"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// A minimal disclosure/accordion primitive — the app ships no accordion, and a
// full-height content preview was pushing Save off-screen when editing a
// material. The header is a toggle button (chevron + title); `headerRight`
// holds sibling controls (e.g. a copy button) that must stay clickable and
// can't nest inside the toggle button. Self-manages `open` from `defaultOpen`,
// or runs controlled via `open`/`onOpenChange` — needed when a caller must
// force a section open (e.g. a validation error inside a collapsed
// disclosure must never stay hidden). Content hides via `hidden`, not
// unmount, so form fields inside keep posting while collapsed.

export function Collapsible({
  title,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  headerRight,
  children,
  className,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  /** Controlled mode — when set, `defaultOpen` is ignored. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  headerRight?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (openProp === undefined) setOpenState(next);
  };
  const regionId = useId();

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={regionId}
          className="focus-visible:ring-ring flex items-center gap-1 rounded-sm text-sm font-medium focus-visible:ring-1 focus-visible:outline-hidden"
        >
          <ChevronDown
            className={cn("size-4 shrink-0 transition-transform", open ? "" : "-rotate-90")}
            aria-hidden="true"
          />
          <span>{title}</span>
        </button>
        {headerRight}
      </div>
      <div id={regionId} hidden={!open} className="space-y-2">
        {children}
      </div>
    </div>
  );
}
