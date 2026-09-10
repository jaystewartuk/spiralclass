import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A labelled figure in an "at a glance" card — the aside pattern the class
 * list introduced and the student roster is the second user of.
 *
 * Shared on the second use, for the same reason `StatCard` and `EmptyState`
 * are shared: the interesting part is not the flex row, it is the two rules
 * below, and a copy is a copy of the markup that quietly leaves the rules
 * behind.
 *
 * It is a `<dt>`/`<dd>` pair, so the caller wraps a group of these in a `<dl>`
 * — a labelled figure IS a description list, and rendering it as two divs
 * loses the association a screen reader uses to read the pair together.
 */
export function GlanceRow({
  label,
  value,
  tone = "default",
  href,
}: {
  label: ReactNode;
  value: number;
  /** `warning` marks the one figure that is a job rather than a fact. */
  tone?: "default" | "warning";
  href?: string;
}) {
  const figure = (
    <span
      className={cn(
        "text-lg font-semibold tabular-nums",
        tone === "warning" && value > 0 && "text-warning",
      )}
    >
      {value}
    </span>
  );

  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd>
        {/* Underlined rather than colour-only: the figure beside it is already
            coloured to mean "this one is a job", so hue cannot also be what
            says "this one is a link". */}
        {href && value > 0 ? (
          <Link href={href} className="underline underline-offset-4">
            {figure}
          </Link>
        ) : (
          figure
        )}
      </dd>
    </div>
  );
}
