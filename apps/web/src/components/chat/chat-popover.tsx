"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Gap between the trigger and the panel, and the panel and the viewport edge. */
const GUTTER_PX = 8;

type Placement = { top: number; left: number };

/**
 * The one floating panel the chat surface uses — the per-message action menu
 * and the composer's attachment menu are this component with different
 * contents.
 *
 * It exists because those were hand-rolled `absolute` divs behind a
 * `fixed inset-0` click-catcher, which got three things wrong at once. There
 * was no Escape, no focus movement, no return focus and no `role`, so a
 * keyboard or screen-reader user had no menu at all. The catcher swallowed the
 * first click anywhere on the page. And an absolutely-positioned panel inside
 * the message list — an `overflow-y-auto` column — was clipped by the scroll
 * box for any message that was not near the middle of the screen.
 *
 * So the panel is portalled to the document and positioned against the
 * trigger's viewport rect, clamped to stay on screen. That is the only
 * arrangement that survives both a narrow phone and a scroll container.
 *
 * `open` is controlled by the caller so the thread can keep its "one panel at
 * a time" invariant across hundreds of rows.
 *
 * Items opt into roving focus with `data-chat-menu-item`; anything without it
 * (a heading, a separator) is skipped by the arrow keys.
 */
export function ChatPopover({
  open,
  onOpenChange,
  label,
  icon,
  align = "left",
  panelClassName,
  triggerVariant = "ghost",
  triggerClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name, used for both the trigger and the panel. */
  label: string;
  icon: React.ReactNode;
  /** Which edge of the trigger the panel prefers to line up with. */
  align?: "left" | "right";
  panelClassName?: string;
  triggerVariant?: ButtonProps["variant"];
  triggerClassName?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  // Set while closing FROM the panel, so focus returns to the trigger only
  // when the reader was inside it — not when they clicked elsewhere.
  const restoreFocusRef = useRef(false);

  const close = useCallback(
    (restoreFocus = true) => {
      restoreFocusRef.current = restoreFocus;
      onOpenChange(false);
    },
    [onOpenChange],
  );

  const items = useCallback(
    () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>("[data-chat-menu-item]") ?? [],
      ).filter((el) => !el.hasAttribute("disabled")),
    [],
  );

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const anchor = trigger.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = panel;
    const clamp = (value: number, max: number) =>
      Math.max(GUTTER_PX, Math.min(value, max - GUTTER_PX));

    // Prefer whichever side of the trigger has room; below when both do, so a
    // menu opens the way the pointer is already travelling.
    const below = anchor.bottom + GUTTER_PX;
    const fitsBelow = below + height <= window.innerHeight - GUTTER_PX;
    const top = fitsBelow ? below : anchor.top - height - GUTTER_PX;
    const preferredLeft = align === "right" ? anchor.right - width : anchor.left;
    setPlacement({
      top: clamp(top, window.innerHeight - height),
      left: clamp(preferredLeft, window.innerWidth - width),
    });
  }, [align]);

  // Measure before paint so the panel never appears in the wrong place first.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  // Move focus into the panel on open, and back to the trigger on close.
  useEffect(() => {
    if (open) {
      items()[0]?.focus();
      return;
    }
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open, items]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    // Capture, so the message list's own scrolling keeps the panel glued to
    // the message it belongs to rather than leaving it behind.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close, reposition]);

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const navigationKeys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!navigationKeys.includes(event.key)) return;
    const focusable = items();
    if (focusable.length === 0) return;
    event.preventDefault();
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = focusable.length - 1;
    else if (current < 0) next = forward ? 0 : focusable.length - 1;
    else next = (current + (forward ? 1 : -1) + focusable.length) % focusable.length;
    focusable[next]?.focus();
  };

  const panel = (
    <div
      ref={panelRef}
      id={panelId}
      role="menu"
      aria-label={label}
      onKeyDown={onPanelKeyDown}
      style={placement ? { top: placement.top, left: placement.left } : undefined}
      className={cn(
        "z-over-overlay border-border bg-popover text-popover-foreground shadow-brand-lg fixed rounded-lg border p-1",
        placement ? "opacity-100" : "opacity-0",
        panelClassName,
      )}
    >
      {children(close)}
    </div>
  );

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant={triggerVariant}
        size="icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : onOpenChange(true))}
        className={triggerClassName}
      >
        {icon}
      </Button>
      {open && typeof document !== "undefined" && createPortal(panel, document.body)}
    </>
  );
}

/** A row inside a menu panel. Full-width, 44px tall on touch. */
export function ChatMenuItem({
  icon,
  label,
  onSelect,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
  tone?: "default" | "destructive";
}) {
  return (
    <Button
      type="button"
      role="menuitem"
      data-chat-menu-item
      variant="ghost"
      tabIndex={-1}
      onClick={onSelect}
      className={cn(
        "h-11 w-full justify-start gap-2.5 px-3 font-normal lg:h-10",
        tone === "destructive" && "text-destructive hover:text-destructive",
      )}
    >
      {icon}
      {label}
    </Button>
  );
}
