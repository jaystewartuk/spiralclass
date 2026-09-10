import { MARK, MARK_SIMPLIFY_BELOW, MARK_SMALL } from "@spiralclass/shared";
import { cn } from "@/lib/utils";

/**
 * The mark, drawn from the shared geometry rather than from a copy of it.
 *
 * The path data used to live here as two hand-written arc chains — one of
 * sixteen copies across the codebase, carrying five hex values that had all
 * drifted from the tokens. It now comes from `packages/shared/src/brand/mark.ts`,
 * which `pnpm brand:assets` also generates every static SVG from.
 *
 * The shape is a logarithmic spiral, because the name is the pedagogy: a spiral
 * curriculum returns to the same material at increasing depth. The opening pass
 * is gold and the rest is ink — the same path, revisited further on.
 */

type LogoSize = "sm" | "md" | "lg" | "xl";

const SIZES: Record<LogoSize, { mark: number; text: string; gap: string; stackedText: string }> = {
  sm: { mark: 24, text: "text-base", gap: "gap-2", stackedText: "text-base" },
  md: { mark: 32, text: "text-lg", gap: "gap-2.5", stackedText: "text-xl" },
  lg: { mark: 44, text: "text-2xl", gap: "gap-3", stackedText: "text-2xl" },
  xl: { mark: 60, text: "text-3xl", gap: "gap-4", stackedText: "text-4xl" },
};

/**
 * `default` sits on a page surface. `inverted` sits on a filled brand ground,
 * where the ink half has to become the light colour or it disappears — the old
 * static lockups hardcoded near-black and vanished on anything dark. `mono`
 * drops to one colour for places that only get one: a print header, a favicon
 * mask, an email client that strips colour.
 */
type MarkVariant = "default" | "inverted" | "mono";

export function LogoMark({
  size = 32,
  variant = "default",
  className,
}: {
  size?: number;
  variant?: MarkVariant;
  className?: string;
}) {
  // Below 48px the full mark's inner coil fills in and the gold pass becomes a
  // smudge. Verified by rendering at 16, 24, 32, 64 and 128, not assumed.
  const small = size < MARK_SIMPLIFY_BELOW;
  const geometry = small ? MARK_SMALL : MARK;

  const ink = variant === "inverted" ? "hsl(var(--primary-foreground))" : "hsl(var(--primary))";
  const gold = "hsl(var(--accent))";
  const singleColour = variant === "mono" ? "currentColor" : ink;

  return (
    <svg
      width={size}
      height={size}
      viewBox={geometry.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      role="img"
      aria-label="SpiralClass"
      fill="none"
    >
      {small || variant === "mono" ? (
        <path
          d={geometry.full}
          stroke={singleColour}
          strokeWidth={geometry.strokeWidth}
          strokeLinecap="round"
        />
      ) : (
        <>
          <path d={MARK.rest} stroke={ink} strokeWidth={MARK.strokeWidth} strokeLinecap="round" />
          <path d={MARK.first} stroke={gold} strokeWidth={MARK.strokeWidth} strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/**
 * The wordmark is set, not drawn: one word, tight tracking, in the same face
 * the rest of the product reads in.
 *
 * `SpiralClass` in camel case, matching every other appearance of the name. The
 * header used to render it lowercase while the footer and all copy rendered it
 * title case — the kind of inconsistency nobody names and everybody feels.
 */
function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("tracking-wordmark text-foreground font-bold", className)}>
      SpiralClass
    </span>
  );
}

export function Logo({
  size = "md",
  withWordmark = true,
  variant = "default",
  className,
}: {
  size?: LogoSize;
  withWordmark?: boolean;
  variant?: MarkVariant;
  className?: string;
}) {
  const s = SIZES[size];
  return (
    <span className={cn("inline-flex items-center", s.gap, className)}>
      <LogoMark size={s.mark} variant={variant} />
      {withWordmark && <Wordmark className={s.text} />}
    </span>
  );
}

export function LogoStacked({
  size = "lg",
  variant = "default",
  className,
}: {
  size?: LogoSize;
  variant?: MarkVariant;
  className?: string;
}) {
  const s = SIZES[size];
  return (
    <span className={cn("inline-flex flex-col items-center gap-2 text-center", className)}>
      <LogoMark size={s.mark + 8} variant={variant} />
      <Wordmark className={s.stackedText} />
    </span>
  );
}
