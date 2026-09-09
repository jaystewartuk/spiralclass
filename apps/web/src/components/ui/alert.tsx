import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative w-full rounded-md border px-4 py-3 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-3.5 [&>svg]:h-4 [&>svg]:w-4 [&>svg~*]:pl-7",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-card-foreground",
        success: "border-success/30 bg-success-bg text-success dark:bg-success-bg",
        warning: "border-warning/30 bg-warning-bg text-warning dark:bg-warning-bg",
        info: "border-info/30 bg-info-bg text-info dark:bg-info-bg",
        destructive:
          "border-destructive/30 bg-destructive-bg text-destructive dark:bg-destructive-bg",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, role = "status", ...props }, ref) => (
  <div ref={ref} role={role} className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = "Alert";

type AlertTitleProps = React.HTMLAttributes<HTMLHeadingElement> & {
  as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p";
};
/**
 * `as` for the same reason CardTitle has it: the tag is the document outline
 * and the styling is not, so an alert that is a top-level section of a page
 * should not be an `<h5>` sitting between that page's `<h1>` and its `<h2>`s.
 * The default stays `h5` — every existing call site keeps the tag it had.
 */
const AlertTitle = React.forwardRef<HTMLParagraphElement, AlertTitleProps>(
  ({ className, as: Comp = "h5", ...props }, ref) => (
    <Comp ref={ref} className={cn("mb-1 font-medium leading-none", className)} {...props} />
  ),
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
