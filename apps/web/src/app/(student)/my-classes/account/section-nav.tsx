"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type AccountSection = { id: string; label: string };

/**
 * The jump nav for this screen.
 *
 * It exists because the STUDENT gets on one page what the teacher gets as six
 * separate settings pages (`/settings/account`, `/settings/notifications`,
 * `/settings/calendar`, …). One page carrying six topics needs to say what is
 * on it and let someone go straight there; without that the only way to find
 * "change my email" is to scroll and read.
 *
 * Scroll-spy rather than `:target`, so the current chip keeps up with plain
 * scrolling too — the nav is a position indicator, not just a set of links.
 */
export function SectionNav({ sections, label }: { sections: AccountSection[]; label: string }) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");

  useEffect(() => {
    const elements = sections
      .map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;

    const onScreen = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onScreen.add(entry.target.id);
          else onScreen.delete(entry.target.id);
        }
        // The topmost section still in the band wins. When none is — a short
        // final section already past it — the last answer stands: a nav that
        // goes blank at the bottom of the page reads as broken.
        const top = sections.find((section) => onScreen.has(section.id));
        if (top) setActive(top.id);
      },
      // A band just below the sticky chrome, ending at mid-viewport, so the
      // current chip changes when a section reaches the top of the reading
      // area rather than when it first appears at the bottom.
      { rootMargin: "-112px 0px -55% 0px" },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav
      aria-label={label}
      // Sticky only from `desktop` up. Below it the site header is already 56px
      // of sticky chrome and these chips are 44px touch targets — together a
      // seventh of a phone viewport spent on navigation. There the row rides at
      // the top of the page as a contents list and scrolls away with it.
      className="z-30 -mx-4 border-y bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 desktop:sticky desktop:top-14"
    >
      {/* The row scrolls sideways when the labels outrun the column — six
          chips fit at `reading` width in English, and not in every language. */}
      <ul className="flex gap-1 overflow-x-auto py-2">
        {sections.map((section) => {
          const current = section.id === active;
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={current ? "true" : undefined}
                className={cn(
                  "flex min-h-target items-center rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-hidden desktop:min-h-0",
                  current
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
