import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, "aria-invalid": ariaInvalid, ...props }, ref) => {
    const isInvalid = invalid ?? (ariaInvalid === true || ariaInvalid === "true");
    return (
      <textarea
        aria-invalid={isInvalid || undefined}
        className={cn(
          // text-base on mobile avoids iOS focus auto-zoom; shrinks to text-sm
          // on larger screens to match the rest of the desktop UI.
          "border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-24 w-full rounded-md border px-3 py-2 text-base focus-visible:ring-3 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-20 lg:text-sm",
          isInvalid && "border-destructive focus-visible:ring-destructive",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
