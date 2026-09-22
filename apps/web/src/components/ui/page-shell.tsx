import { cn } from "@/lib/utils";

/**
 * The column a screen's content sits in.
 *
 * Seventy-two screens set this by hand, and the two most common values —
 * `lg:max-w-2xl` and `lg:max-w-3xl` — were used 26 and 29 times. A near coin
 * flip, chosen per screen, with nothing saying which was right. That is also
 * why the landing page's own sections disagreed with each other: the AI demo
 * sat in about 570px and the feature grid in about 1000px, same page, same
 * viewport.
 *
 * Three widths, each with a reason:
 *
 *   `reading` — prose and forms. Capped in CHARACTERS, not pixels, because line
 *               length is one of the strongest reported barriers for a dyslexic
 *               reader (D-140) — and a ch cap holds its measure at whatever
 *               text size the reader has chosen, where a px cap silently gets
 *               longer as the text grows.
 *   `default` — lists and detail screens.
 *   `wide`    — surfaces that genuinely need the room: calendars, tables, admin.
 *
 * Below `lg` every width is the same, because below `lg` there is one column.
 */
const WIDTHS = {
  reading: "lg:max-w-reading",
  default: "lg:max-w-3xl",
  wide: "lg:max-w-content",
} as const;

/**
 * Renders `<main>` by default, because that is what every screen this replaces
 * was already using and swapping it for a div would quietly remove a landmark
 * a screen-reader user navigates by. `as` is there for the shells nested inside
 * a page that already has one.
 */
export function PageShell({
  as: Tag = "main",
  width = "default",
  children,
  className,
}: {
  as?: "main" | "div" | "section";
  width?: keyof typeof WIDTHS;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tag className={cn("container space-y-6 py-10", WIDTHS[width], className)}>{children}</Tag>
  );
}
