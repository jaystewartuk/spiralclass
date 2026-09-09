import { Heading } from "@/components/ui/heading";
import { cn } from "@/lib/utils";

/**
 * The title block every screen starts with.
 *
 * A hand-rolled page title appeared 82 times, in six different
 * combinations — `text-2xl`, `text-xl`, `text-3xl`, some with
 * `font-display`, some with `tracking-tight`. Six answers to a question that
 * should have one, and the reason a page title's size depended on which screen
 * you were looking at.
 *
 * Hierarchy here comes from size and space, not from a second typeface: D-140
 * removed the display face rather than swapping it, so `font-display` resolves
 * to the same family and only added noise.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons or links that act on the whole screen. */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} as="h1">
          {title}
        </Heading>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
