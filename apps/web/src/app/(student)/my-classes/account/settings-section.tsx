import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { cn } from "@/lib/utils";

/**
 * The two layout primitives this screen is built from.
 *
 * The page used to be twelve free-standing `Card`s in one flat stack, and the
 * hierarchy that produced was not weak — it was ABSENT. `CardTitle` is
 * `text-2xl` (22px) and `PageHeader` renders its `<h1>` at `text-h2`, which is
 * also 22px: the page title and all twelve card titles were the same size, so
 * nothing on the screen said what contained what. Twelve equal shouts.
 *
 * So: SECTIONS group the topics and carry the `<h2>`, one raised card each.
 * ROWS are the settings inside a section, separated by a hairline rather than
 * by another card, and carry the `<h3>`. That gives four real typographic
 * tiers — 22 page / 19 section / 17 row / 15 supporting — off the shared scale,
 * with no new sizes invented, plus a structural cue the sizes alone can't give:
 * a section label sits on the page ground, a row title sits inside the card.
 *
 * `id` is load-bearing twice over — it anchors the jump nav (section-nav.tsx)
 * and it names the landmark via `aria-labelledby`, so the section list a screen
 * reader announces and the one the nav shows are the same list by construction.
 */
export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    // scroll-mt clears the sticky header (h-14) plus the sticky section nav, so
    // a jump lands on the heading rather than under the chrome.
    <section id={id} aria-labelledby={headingId} className="scroll-mt-28 space-y-3">
      <div className="space-y-1">
        <Heading level={3} as="h2" id={headingId}>
          {title}
        </Heading>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      <Card className="divide-border divide-y overflow-hidden">{children}</Card>
    </section>
  );
}

/**
 * One setting inside a section.
 *
 * Title and control stack rather than sitting in two columns: the shell is
 * capped at `reading` (66ch), and a label column would leave the phone-number
 * field and the timezone select fighting over ~380px. Stacking keeps every
 * control full-width at every viewport, which is also the mobile layout — one
 * arrangement instead of two.
 */
export function SettingsRow({
  title,
  description,
  tone = "default",
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** `danger` tints the row and colours its title — for irreversible actions. */
  tone?: "default" | "danger";
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-4 p-5 lg:p-6", tone === "danger" && "bg-destructive-bg/25")}>
      {title || description ? (
        <div className="space-y-1">
          {title ? (
            <Heading level={4} as="h3" className={cn(tone === "danger" && "text-destructive")}>
              {title}
            </Heading>
          ) : null}
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
