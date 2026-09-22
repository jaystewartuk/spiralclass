"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type NavSection = { id: string; label: string };

/**
 * Sticky quick-jump links for a screen that is one long column of sections.
 *
 * Generalized out of the student detail page's own copy, which is now a thin
 * wrapper over this. Two callers is not much of a pattern; the reason to share
 * it is that the scroll-spy is the fiddly part, and the second caller was about
 * to reproduce the same `IntersectionObserver` and the same off-by-a-header
 * `rootMargin`.
 *
 * Anchors, not buttons: a link to `#id` works before hydration, survives being
 * copied, and gets keyboard and context-menu behaviour from the platform.
 */

/**
 * The section a reader is "in", given which section ids the viewport currently
 * intersects. Always the FIRST visible one in document order.
 *
 * Reading `entries[0].target.id` off the observer callback — which is what the
 * original did — is not the same thing: the callback receives only the entries
 * that CHANGED, in no guaranteed order, so scrolling up out of section three
 * could deliver section four's exit first and light the wrong pill.
 *
 * Exported for its own test; it is the only decision here that can be wrong
 * without looking broken.
 */
export function activeSectionId(
  ids: readonly string[],
  visible: ReadonlySet<string>,
  fallback: string | undefined = ids[0],
): string | undefined {
  return ids.find((id) => visible.has(id)) ?? fallback;
}

// The app header is 56px (h-14) and this bar sits directly under it. A section
// becomes current once it reaches the underside of both, and stops being
// current once its top leaves the upper third of the viewport.
const SPY_ROOT_MARGIN = "-112px 0px -70% 0px";

export function SectionNav({
  sections,
  ariaLabel,
  className,
}: {
  sections: NavSection[];
  ariaLabel: string;
  className?: string;
}) {
  const [activeId, setActiveId] = useState<string | undefined>(sections[0]?.id);
  const listRef = useRef<HTMLDivElement>(null);
  // A stable dependency: every caller builds `sections` inline on each render,
  // and depending on the array itself would tear the observer down and rebuild
  // it on all of them.
  const key = sections.map((s) => s.id).join("|");
  const ids = useMemo(() => key.split("|").filter(Boolean), [key]);

  useEffect(() => {
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el != null);
    if (elements.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        setActiveId(activeSectionId(ids, visible));
      },
      { rootMargin: SPY_ROOT_MARGIN, threshold: 0 },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [ids]);

  // Keep the current pill in view as the reader scrolls past it. Honours
  // prefers-reduced-motion, which a hardcoded `behavior: "smooth"` does not.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`[data-id="${activeId}"]`);
    if (!active) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    active.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [activeId]);

  if (sections.length < 2) return null;

  return (
    <div
      className={cn(
        "sticky top-14 z-30 -mx-4 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:mx-0 lg:rounded-md lg:border",
        className,
      )}
    >
      <nav
        ref={listRef}
        aria-label={ariaLabel}
        className="flex [scrollbar-width:none] gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden"
      >
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            data-id={s.id}
            // `aria-current` rather than colour alone: the active pill differs
            // by a fill and a weight, neither of which reaches a screen reader.
            aria-current={activeId === s.id ? "true" : undefined}
            className={cn(
              "flex shrink-0 items-center rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden",
              activeId === s.id
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {s.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
