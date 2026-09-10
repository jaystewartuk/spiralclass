import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "AI changed this, and here is how to undo it."
 *
 * Extracted because the same chip was written twice, byte for byte, in
 * material-form.tsx and material-editor.tsx — eight raw violet utilities each,
 * with hand-written `dark:` counterparts that were the only ones in the app.
 * Two copies of a thing is how one of them silently stops matching the other.
 *
 * Violet had no token, which is why it was raw. It uses `clay` now: a real
 * accent in the palette, distinct from the status colours so an AI note never
 * reads as a warning, and it inherits dark mode instead of restating it.
 */
export function AiChangeChip({
  children,
  action,
  className,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-clay-bg text-clay flex items-center gap-1.5 rounded-full px-2 py-1",
        className,
      )}
      aria-live="polite"
    >
      <Sparkles className="size-3.5 shrink-0" aria-hidden />
      <span className="text-xs">{children}</span>
      {action}
    </div>
  );
}
