import { cn } from "@/lib/utils";
import { LogoMark } from "./logo";

// Branded replacement for a generic spinner icon — spins the logo mark
// (mono variant, so it inherits the surrounding text color via currentColor)
// instead of a plain ring. Decorative only: hidden from the a11y tree since
// LogoMark's own role="img"/aria-label would otherwise announce "SpiralClass".
export function LogoSpinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span aria-hidden className="inline-flex shrink-0">
      <LogoMark size={size} variant="mono" className={cn("animate-spin", className)} />
    </span>
  );
}
