import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// The icon-tile + title + body card shared by the landing value grid, the AI
// showcase, and the /features grid. Presentational and string-free — all copy
// is passed in already-translated, so this component never touches the i18n
// catalog and the i18n-guard has nothing to flag.
export function FeatureCard({
  icon: Icon,
  title,
  body,
  className,
  titleAs = "h3",
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  className?: string;
  /**
   * The card title's TAG, separate from its size.
   *
   * It was hardcoded `h3`, which is right on the landing page — a Section
   * supplies an h2 above the grid — and wrong on /features, where the cards sit
   * directly under the page's h1 and the outline read h1 then h3. A screen
   * reader navigating by heading level lands on nothing in between and cannot
   * tell whether it has moved into a subsection or missed one.
   *
   * The size does not change with the tag: this is the document outline, which
   * is an accessibility concern, not a visual one.
   */
  titleAs?: "h2" | "h3" | "h4";
}) {
  const Title = titleAs;
  return (
    <div
      className={cn(
        "rounded-2xl border bg-card p-6 text-left shadow-xs transition-shadow hover:shadow-md",
        className,
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <Title className="mt-4 font-display text-h3 font-semibold">{title}</Title>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
