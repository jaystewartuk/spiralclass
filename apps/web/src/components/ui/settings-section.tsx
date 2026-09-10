import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { cn } from "@/lib/utils";

/**
 * A settings screen is a list of decisions, not a stack of objects.
 *
 * The account page was ten peer `Card`s, each with a `text-2xl` title — the
 * same size as the page's own heading. Ten equal shouts is no hierarchy at
 * all, and the reader had to hold the grouping in their head because the page
 * never stated one.
 *
 * So: a `SettingsSection` is a NAMED GROUP — a heading on the page ground with
 * one card under it — and each decision inside is a `SettingRow`, separated by
 * a rule rather than by a gap and a border of its own. Three type sizes,
 * descending: page 22 / section 19 / row 17 (the D-140 scale's h2 / h3 / body,
 * all at semibold, distinguished further by the muted description under each).
 *
 * The section is a real landmark: `<section aria-labelledby>` names it with the
 * heading it already has, so a screen-reader user gets the same grouping the
 * sighted reader gets, and `scroll-mt` keeps the sticky header and quick-jump
 * bar off the heading when an anchor lands here.
 */
export function SettingsSection({
  id,
  title,
  description,
  tone = "default",
  className,
  children,
}: {
  /** Anchor target — also the `SectionNav` entry's id. */
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** `danger` outlines the card, so the irreversible group is not styled
   * identically to "class materials". Colour is never the only signal — the
   * section is also last, named, and its control is a destructive button. */
  tone?: "default" | "danger";
  className?: string;
  children: React.ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className={cn("scroll-mt-28", className)}>
      <div className="mb-3 flex flex-col gap-1">
        <Heading level={3} as="h2" id={headingId}>
          {title}
        </Heading>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <Card className={cn("divide-y divide-border", tone === "danger" && "border-destructive")}>
        {children}
      </Card>
    </section>
  );
}

/** One decision inside a `SettingsSection`. `action` is for a row whose whole
 * control is a single button or link, which then sits beside the title rather
 * than orphaned under it. */
export function SettingRow({
  title,
  description,
  action,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-4 p-6", className)}>
      {title || description || action ? (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 space-y-1">
            {title ? (
              <Heading level={4} as="h3">
                {title}
              </Heading>
            ) : null}
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
