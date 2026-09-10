"use client";

import { useEffect, useMemo, useState } from "react";
import { activeSectionId, type NavSection } from "@/components/ui/section-nav";
import { cn } from "@/lib/utils";

/**
 * The help centre's desktop contents rail: one link per guide, nested links
 * per section, and a highlight that follows the reader down the page.
 *
 * SectionNav is the horizontal version of this and the phone gets it; what it
 * cannot express is the two-level structure, which is the whole point here —
 * four guides of six sections each is twenty-four flat pills, and a reader
 * scanning them cannot tell which guide any given "Troubleshooting" belongs
 * to. The scroll-spy decision itself is NOT duplicated: `activeSectionId` is
 * imported from SectionNav, because "the first visible section in document
 * order, not whichever one the observer reported first" is the one thing here
 * that can be subtly wrong while still looking like it works.
 */

export interface TocGuide {
  id: string;
  label: string;
  sections: NavSection[];
}

// The rail sits below a non-sticky page header, so a section becomes current
// once it reaches the top of the viewport and stops once it leaves the upper
// third — the same shape as SectionNav's margin without its allowance for a
// sticky app bar.
const SPY_ROOT_MARGIN = "-96px 0px -70% 0px";

export function HelpToc({ guides, ariaLabel }: { guides: TocGuide[]; ariaLabel: string }) {
  const flatIds = useMemo(
    () => guides.flatMap((guide) => [guide.id, ...guide.sections.map((s) => s.id)]),
    [guides],
  );
  const [activeId, setActiveId] = useState<string | undefined>(flatIds[0]);

  // A stable dependency: `guides` is rebuilt inline by the page on every
  // render, and depending on the array itself would tear the observer down and
  // build it again on all of them.
  const key = flatIds.join("|");

  useEffect(() => {
    const ids = key.split("|").filter(Boolean);
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
  }, [key]);

  return (
    <nav aria-label={ariaLabel} className="text-sm">
      <ul className="space-y-4">
        {guides.map((guide) => {
          const withinGuide =
            activeId === guide.id || guide.sections.some((section) => section.id === activeId);
          return (
            <li key={guide.id}>
              <a
                href={`#${guide.id}`}
                aria-current={activeId === guide.id ? "true" : undefined}
                className={cn(
                  "block rounded-md py-1 font-semibold transition-colors",
                  withinGuide ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {guide.label}
              </a>
              {/* Only the guide the reader is IN lists its sections. Every
                  guide in docs/help has the same six — "Before you start",
                  "Steps", "Tips", "Troubleshooting", "Questions" — so showing
                  all of them at once is twenty identical-looking rows in which
                  none of the repeated labels says which article it belongs to.
                  Collapsed, the rail is four titles and one open article. */}
              {withinGuide && (
                <ul className="border-border mt-1 space-y-0.5 border-l">
                  {guide.sections.map((section) => (
                    <li key={section.id}>
                      <a
                        href={`#${section.id}`}
                        // `aria-current`, not colour alone: the current item
                        // differs by a weight and a rule, neither of which
                        // reaches a screen reader.
                        aria-current={activeId === section.id ? "true" : undefined}
                        className={cn(
                          "-ml-px block border-l py-1 pl-3 text-xs transition-colors",
                          activeId === section.id
                            ? "border-primary text-foreground font-medium"
                            : "text-muted-foreground hover:border-border hover:text-foreground border-transparent",
                        )}
                      >
                        {section.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
