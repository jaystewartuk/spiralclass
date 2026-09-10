import type { ElementType } from "react";
import { Link2 } from "lucide-react";
import { Heading } from "@/components/ui/heading";
import { cn } from "@/lib/utils";

/**
 * A heading that is also a destination.
 *
 * Every section of the help centre has an id so that search, the contents rail
 * and anyone answering a support question can point at it. The affordance for
 * copying that link is a real `<a href="#id">`, not a copy-to-clipboard
 * button: it works before hydration, the browser's own context menu offers
 * "copy link address", and a middle click opens it — none of which a button
 * writing to `navigator.clipboard` can do.
 *
 * TWO THINGS THAT LOOK LIKE FUSSINESS AND ARE NOT.
 *
 * The link is a SIBLING of the heading, not a child. Nested, its label joins
 * the heading's accessible name, and a screen reader announcing the outline
 * reads "Before you start, link to this section" for all twenty-four of them.
 *
 * And its label names the section. Twenty-four links all called "link to this
 * section" are indistinguishable in the links list a screen-reader user
 * navigates by, which is the one place a link's own words are all they get.
 *
 * The mark is revealed on hover on a pointer device and permanently visible on
 * keyboard focus, so it is never a control that exists only for mouse users.
 */
export function AnchoredHeading({
  targetId,
  level,
  as,
  label,
  linkLabel,
  className,
}: {
  /** The id of the SECTION this heading opens — the anchor's target. The id
   *  lives on the section rather than the heading so a fragment link lands on
   *  the whole block, and so the scroll-spy observes something taller than one
   *  line of text. */
  targetId: string;
  level: 1 | 2 | 3 | 4 | "display";
  as?: ElementType;
  /** The heading's words. A plain string rather than children because the
   *  link's accessible name is built from them. */
  label: string;
  /** Accessible name for the anchor link — already naming this section. */
  linkLabel: string;
  className?: string;
}) {
  return (
    <div className={cn("group flex items-center gap-1", className)}>
      <Heading level={level} as={as} className="min-w-0">
        {label}
      </Heading>
      <a
        href={`#${targetId}`}
        className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Link2 className="h-4 w-4" aria-hidden />
        <span className="sr-only">{linkLabel}</span>
      </a>
    </div>
  );
}
