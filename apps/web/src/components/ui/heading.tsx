import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Headings and body text, applied by name rather than by remembering utilities.
 *
 * WHY, given the scale is now reachable as `text-h2` and friends. Because a
 * heading is never only a size. The 129 hand-rolled ones in this codebase
 * carried a size, a weight, sometimes a family, and — in 29 of them —
 * `tracking-tight`, which D-140 withdrew. Every one was an independent chance
 * to get one of those four wrong, and 29 of them took it.
 *
 * `level` is the SIZE. `as` is the TAG. They are separate on purpose: document
 * outline is an accessibility concern and visual weight is a design one, and
 * conflating them is how a page ends up with an `<h4>` chosen because the
 * designer wanted smaller text. A card title that should read as `<h3>` in the
 * outline but sit at the h2 size says so explicitly.
 */

const LEVELS = {
  display: "text-display font-display font-semibold",
  1: "text-h1 font-display font-semibold",
  2: "text-h2 font-display font-semibold",
  3: "text-h3 font-semibold",
  4: "text-base font-semibold",
} as const;

const DEFAULT_TAG: Record<keyof typeof LEVELS, ElementType> = {
  display: "h1",
  1: "h1",
  2: "h2",
  3: "h3",
  4: "h4",
};

export function Heading({
  level = 2,
  as,
  className,
  id,
  children,
}: {
  level?: keyof typeof LEVELS;
  as?: ElementType;
  className?: string;
  /** For `aria-labelledby` — a landmark named by the heading it already has,
   * rather than by an `aria-label` that duplicates the same words in a second
   * place where the two can drift apart. */
  id?: string;
  children: ReactNode;
}) {
  const Tag = as ?? DEFAULT_TAG[level];
  // No `tracking` anywhere in these classes, and that is the point: D-140
  // withdrew negative letter-spacing, and a primitive is the only place that
  // decision can actually hold.
  return (
    <Tag id={id} className={cn(LEVELS[level], className)}>
      {children}
    </Tag>
  );
}

const TONES = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  // `text-subtle`, not `text-foreground-subtle`. The token is registered in
  // tailwind.config.ts as the colour `subtle`; `foreground` is a plain string
  // there, so `text-foreground-subtle` resolves to nothing at all — Tailwind
  // does not error on a class it cannot build, so the text simply inherited
  // `text-foreground` and the faintest step in the ramp was never once
  // rendered.
  subtle: "text-subtle",
} as const;

const SIZES = {
  body: "text-base",
  small: "text-sm",
} as const;

/**
 * Body copy. Deliberately only two sizes and three tones — the point is to
 * make the common cases nameable, not to rebuild the utility API with longer
 * names. Anything outside this reaches for the utilities directly and should.
 */
export function Text({
  size = "body",
  tone = "default",
  as: Tag = "p",
  className,
  children,
}: {
  size?: keyof typeof SIZES;
  tone?: keyof typeof TONES;
  as?: ElementType;
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={cn(SIZES[size], TONES[tone], className)}>{children}</Tag>;
}
