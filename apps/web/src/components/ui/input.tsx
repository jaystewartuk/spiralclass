import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** When true, marks the input as invalid and adds destructive ring + border. */
  invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, invalid, "aria-invalid": ariaInvalid, ...props }, ref) => {
    const isInvalid = invalid ?? (ariaInvalid === true || ariaInvalid === "true");
    return (
      <input
        type={type}
        aria-invalid={isInvalid || undefined}
        className={cn(
          // text-base on mobile keeps iOS Safari from auto-zooming on focus
          // (<16px triggers it); h-11 gives a comfortable touch target.
          "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 lg:h-10 lg:text-sm",
          isInvalid && "border-destructive focus-visible:ring-destructive",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
