import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Emphasis is carried by fill + elevation + weight + a press state, not hue
  // alone, so the variants read as distinct levels. `active:translate-y-px`
  // gives every button a physical press; filled variants also drop their shadow
  // on press. Transition covers colour, shadow and transform for that motion.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[color,background-color,border-color,box-shadow,transform] focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // High emphasis: solid brand fill, elevated, bold, presses down.
        default:
          "bg-primary text-primary-foreground font-semibold shadow-brand-sm hover:bg-primary-hover active:bg-primary/80 active:translate-y-px active:shadow-none",
        destructive:
          "bg-destructive text-destructive-foreground font-semibold shadow-brand-sm hover:bg-destructive/90 active:bg-destructive/80 active:translate-y-px active:shadow-none",
        // Medium emphasis: a neutral filled control with a border — reads as a
        // button, distinct from the low-emphasis outline/ghost below.
        secondary:
          "bg-secondary text-secondary-foreground font-semibold border border-border hover:bg-muted active:bg-secondary/70 active:translate-y-px",
        // Low emphasis: bordered, no fill at rest; fills to the neutral `muted`
        // on interaction (NOT the vivid gold accent).
        outline:
          "border border-border bg-transparent hover:bg-muted hover:text-foreground active:bg-muted/70 active:translate-y-px",
        // Ghost button for placing ON a `bg-primary` (or other colored) panel.
        // Keyed entirely to `--primary-foreground` — the one token guaranteed
        // to contrast with `--primary` in BOTH themes — and a transparent fill,
        // so it never paints the page background over the panel. Use this instead
        // of `outline` on colored surfaces; plain `outline` carries `bg-background`,
        // which collides with the panel and inverts in dark mode.
        outlineOnPrimary:
          "border border-primary-foreground bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground",
        // Lowest emphasis: no border, no fill until hovered.
        ghost: "hover:bg-muted hover:text-foreground active:bg-muted/70",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        // Larger hit areas on touch screens (>=44px), tapering to the
        // original compact desktop sizing at the sm breakpoint.
        default: "h-11 px-4 py-2 lg:h-10",
        sm: "h-10 rounded-md px-3 lg:h-9",
        lg: "h-12 rounded-md px-6 lg:h-11 lg:px-8",
        icon: "h-11 w-11 lg:h-10 lg:w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
