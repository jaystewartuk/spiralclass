"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Ellipsis, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

export type CallMoreItem = {
  key: string;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  active?: boolean;
};

// The phone's overflow for the call controls. A teacher's full set is eight
// buttons, which on a phone wrapped into two rows and took a third of the
// screen; below `sm` the row keeps what a lesson needs every minute
// (microphone, camera, captions, materials, leave) and the rest are here, one
// tap further. On wider screens the row shows everything and this is hidden.
export function CallMoreMenu({ items }: { items: CallMoreItem[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div ref={rootRef} className="relative sm:hidden">
      <Button
        variant="ghost"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("call.more")}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="menu"
        className="h-auto w-12 flex-col gap-1.5 rounded-lg p-0 hover:bg-transparent active:bg-transparent"
      >
        <span
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-colors",
            open
              ? "bg-overlay-4 text-scrim-3"
              : "bg-overlay-1 text-white backdrop-blur-md hover:bg-overlay-2",
          )}
        >
          <Ellipsis className="h-5 w-5" aria-hidden />
        </span>
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t("call.more")}
          // z-50: it opens upward over the stage, whose material viewer and
          // corner tiles carry their own z-index — without one of its own,
          // everything but the bottom item rendered underneath them.
          className="absolute bottom-full left-1/2 z-50 mb-3 w-56 -translate-x-1/2 rounded-2xl border border-overlay-2 bg-scrim-3 p-1.5 shadow-lg backdrop-blur-md"
        >
          {items.map((item) => (
            <Button
              variant="ghost"
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              aria-pressed={item.active}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "h-auto min-h-target w-full justify-start gap-3 rounded-xl px-3 text-left text-sm font-medium text-white hover:bg-overlay-1 hover:text-white active:bg-overlay-2 disabled:opacity-50",
                item.active && "bg-overlay-1",
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" aria-hidden />
              {item.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
