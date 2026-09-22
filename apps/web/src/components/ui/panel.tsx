import { cn } from "@/lib/utils";

/**
 * A titled region inside a screen: flat on the page, separated by a rule.
 *
 * Distinct from `Card`, which is a raised object among objects.
 *
 * A CORRECTION, because the reasoning that produced this was wrong. It was
 * written to replace "thirteen `*-panel.tsx` files that share nothing" — but
 * that was a naming observation, not evidence of duplicated markup. Checked
 * afterwards: those thirteen are feature modules with no common chrome, and the
 * 45 hand-rolled `<h2>` sections are mostly legal prose in Terms and Privacy,
 * where a top rule would be wrong.
 *
 * So this is used by `/design` and by anything that genuinely wants a ruled
 * section, and it is NOT a migration target. Kept rather than deleted because
 * it does the job well where it is used; the claim about thirteen files is
 * removed rather than left to mislead the next person.
 */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3 border-t border-border pt-5", className)}>
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-bold">{title}</h2>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
