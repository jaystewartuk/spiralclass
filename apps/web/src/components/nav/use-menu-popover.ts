"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { usePathname } from "next/navigation";

// The behaviour shared by the two header dropdowns (the avatar menu and the
// "Your page" / "Materials" group menus). Both had hand-written copies of the
// dismiss effects; neither had any keyboard model beyond Escape, so a menu you
// opened with the keyboard dropped you at its first item only by accident of
// DOM order and offered no way through it but Tab.
//
// What this adds over the two copies it replaces:
//
//   * focus moves INTO the panel when it opens, and back to the trigger when
//     Escape closes it;
//   * Up/Down/Home/End move between items, the standard model for a menu;
//   * tabbing out of the panel closes it, so a keyboard user is never left
//     with an open menu they have already left behind.
//
// A note on roles: these panels are NOT `role="menu"`. That role promises the
// menu keyboard model over `menuitem` CHILDREN only, and the avatar panel
// holds a <select>, a segmented control and a sign-out form — none of which
// are menu items, and all of which a screen reader would mis-announce inside
// one. They are disclosures: a button with `aria-expanded` revealing a
// labelled group of ordinary controls, which is what they actually are.

const FOCUSABLE =
  'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useMenuPopover() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  // Close on navigation so the menu never lingers over the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Dismiss on outside click and Escape; restore focus to the trigger when
  // Escape closes it so keyboard users aren't dropped at the top of the page.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Hand the first item focus on open. Programmatic focus after a click does
  // not match :focus-visible, so this is invisible to mouse users and is the
  // whole interaction for keyboard ones.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open]);

  const items = useCallback(
    () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    [],
  );

  const onPanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(event.key)) return;
      const focusable = items();
      if (focusable.length === 0) return;
      event.preventDefault();
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? focusable.length - 1
            : event.key === "ArrowDown"
              ? (current + 1) % focusable.length
              : (current - 1 + focusable.length) % focusable.length;
      focusable[next]?.focus();
    },
    [items],
  );

  // Tabbing (or clicking) out of the panel closes it. `relatedTarget` is the
  // element receiving focus; null means focus went nowhere in particular
  // (a click on empty space), which the outside-pointerdown handler already
  // covers.
  const onContainerBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && !event.currentTarget.contains(next)) setOpen(false);
  }, []);

  return {
    open,
    setOpen,
    toggle,
    close,
    containerRef,
    triggerRef,
    panelRef,
    onPanelKeyDown,
    onContainerBlur,
  };
}
