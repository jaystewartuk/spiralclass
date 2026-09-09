import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        // A SOLID fill, not `bg-primary/10 text-primary`.
        //
        // This variant was the last one still painting an opacity: a 10% tint
        // composited against whatever surface it landed on, then written on in
        // `primary`. That is the identical defect the status variants below
        // were migrated off when the `*-bg` grounds were added — a colour no
        // token names, so the contrast test cannot assert it and axe finds it
        // instead. It measured 3.09:1 in dark mode.
        //
        // The fix is a ground the palette already verifies (`primaryText` on
        // `primary`) rather than a seventh `*-bg` token, and it incidentally
        // unifies this with the solid count chips that were hand-rolled as
        // `bg-primary text-primary-foreground` in three places.
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        success: "border-transparent bg-success-bg text-success",
        warning: "border-transparent bg-warning-bg text-warning",
        info: "border-transparent bg-info-bg text-info",
        clay: "border-transparent bg-clay-bg text-clay",
        sage: "border-transparent bg-sage-bg text-sage",
        destructive: "border-transparent bg-destructive-bg text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
