"use client";

import { useId } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { NavRow } from "@/components/nav/nav-row";
import { useMenuPopover } from "@/components/nav/use-menu-popover";
import { Button } from "@/components/ui/button";
import { isWebNavActive, type WebNavLink } from "@/lib/nav";
import { navIcon } from "@/lib/nav-icons";
import { cn } from "@/lib/utils";

// A labelled dropdown in the header bar that gathers a nav group's destinations
// (e.g. "Your page" — Leads/Testimonials/public page; or "Materials" —
// Materials/Focus tags/Lesson templates). It gives those destinations a real,
// top-level home instead of leaving them stranded in the dashboard grid or
// buried in settings. Rendered only at desktop widths with a mouse — the phone
// drawer lists the same links inline.
//
// Rows come from the shared NavRow, so a destination looks the same here as it
// does in the drawer and the tablet rail: same icon, same active treatment,
// same focus ring. Dismissal and the keyboard model come from useMenuPopover.
export function PageMenu({ links, label }: { links: WebNavLink[]; label: string }) {
  const pathname = usePathname();
  const menuId = useId();
  const { open, toggle, containerRef, triggerRef, panelRef, onPanelKeyDown, onContainerBlur } =
    useMenuPopover();

  // Light up the trigger when any of its destinations is the current page.
  const anyActive = links.some((link) => isWebNavActive(link, pathname));

  return (
    <div ref={containerRef} onBlur={onContainerBlur} className="relative">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={toggle}
        className={cn(
          "gap-1 font-medium whitespace-nowrap",
          anyActive || open
            ? "bg-muted font-semibold text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
        <ChevronDown
          aria-hidden
          className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </Button>

      {open && (
        <div
          id={menuId}
          ref={panelRef}
          onKeyDown={onPanelKeyDown}
          aria-label={label}
          className="absolute left-0 z-50 mt-2 max-h-menu w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {links.map((link) => {
            const active = isWebNavActive(link, pathname);
            return (
              <NavRow
                key={link.key}
                href={link.href}
                icon={navIcon(link.key)}
                active={active}
                external={link.external}
                density="compact"
                label={
                  <>
                    <span className="block">{link.label}</span>
                    {link.description && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {link.description}
                      </span>
                    )}
                  </>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
