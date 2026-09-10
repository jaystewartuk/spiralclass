import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * "There is nothing here yet."
 *
 * There was no shared empty state at all — every list wrote its own, so the
 * icon size, the padding and whether there was an icon at all varied by screen.
 * It is the most-repeated piece of markup in the app that had no primitive.
 *
 * The icon is decorative and marked so: it repeats what the text already says,
 * and a screen reader announcing it twice is worse than not having it.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        {Icon ? <Icon className="text-muted-foreground/40 h-10 w-10" aria-hidden /> : null}
        <p className="text-foreground font-bold">{title}</p>
        {description ? (
          <p className="text-muted-foreground max-w-prose text-sm">{description}</p>
        ) : null}
        {action}
      </CardContent>
    </Card>
  );
}
