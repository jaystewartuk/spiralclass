import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SectionVariant = "plain" | "band";

/**
 * A marketing section: a full-bleed ground with one content column inside it.
 *
 * WHY THE WIDTH IS A PROP. It used not to be, and the consequence was visible
 * on the landing page — the wedge sat in 768px, the AI feature grid in 1024px
 * and the steps list in 768px again, because each child set its own
 * `mx-auto max-w-*`. Bands that share a ground but not a column read as three
 * pages stacked. The column belongs to the section, so it is set once here and
 * the children just fill it.
 *
 * The grounds stay full-bleed on purpose: an alternating band that stopped at
 * the content edge would be a card, not a band.
 */
const WIDTHS = {
  // Prose. Capped in CHARACTERS for the same reason PageShell's is (D-140):
  // a px cap silently gets longer as the reader turns the text size up.
  reading: "max-w-reading",
  // Two-up comparisons and short lists — the default for anything that is
  // read rather than scanned.
  default: "max-w-3xl",
  // Card grids that genuinely want three columns. Bounded by the container.
  wide: "max-w-none",
} as const;

export function Section({
  variant = "plain",
  width = "default",
  eyebrow,
  title,
  description,
  headingAs: Heading = "h2",
  children,
  className,
}: {
  variant?: SectionVariant;
  width?: keyof typeof WIDTHS;
  eyebrow?: string;
  title?: string;
  description?: string;
  headingAs?: ElementType;
  children?: ReactNode;
  className?: string;
}) {
  const hasHeader = Boolean(eyebrow || title || description);
  return (
    <section className={cn(variant === "band" && "bg-secondary/40 border-y", className)}>
      <div className="container py-16">
        {hasHeader && (
          // The header always sits in the reading column even when the content
          // below it is wide: a centred title stretched to 1280px is two eye
          // movements per line for no gain.
          <div className="max-w-reading mx-auto text-center">
            {eyebrow && (
              // NOT uppercase, and not letter-spaced. D-140 reversed that from
              // its own earlier draft: capitals remove the word-shape cue and
              // tracking opens letter spacing without opening word spacing,
              // which is the pairing that makes words run together.
              <p className="text-primary text-sm font-semibold">{eyebrow}</p>
            )}
            {title && (
              <Heading className="font-display text-h2 mt-2 font-semibold text-balance">
                {title}
              </Heading>
            )}
            {description && <p className="text-muted-foreground mt-3 text-pretty">{description}</p>}
          </div>
        )}
        {children && (
          <div className={cn("mx-auto", WIDTHS[width], hasHeader && "mt-10")}>{children}</div>
        )}
      </div>
    </section>
  );
}
