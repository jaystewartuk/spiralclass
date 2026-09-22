import { cn } from "@/lib/utils";

// Live "x / max" counter for a length-capped field (booking-page headline/bio
// today). Switches to the warning tone near the limit and to destructive
// right at it, so the cap is obvious before the browser's own maxLength
// silently stops further input.
export function CharacterCounter({
  id,
  length,
  max,
  className,
}: {
  id?: string;
  length: number;
  max: number;
  className?: string;
}) {
  const atLimit = length >= max;
  const nearLimit = !atLimit && length >= max * 0.9;
  return (
    <p
      id={id}
      className={cn(
        // `whitespace-nowrap`: in a narrow column the counter broke as
        // "0 /" over "80", which reads as two numbers rather than a ratio.
        "text-xs whitespace-nowrap text-muted-foreground tabular-nums",
        nearLimit && "text-warning",
        atLimit && "text-destructive",
        className,
      )}
    >
      {length} / {max}
    </p>
  );
}
