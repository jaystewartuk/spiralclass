"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A labelled on/off setting: title, explanation, and a switch.
 *
 * Replaces the hand-rolled `<input type="checkbox" className="h-4 w-4">` rows
 * that self-submitting settings forms grew independently in four places. Three
 * things were wrong with every one of them, and none is fixable at a call site:
 *
 *  - **A 16px target.** D-140 sets the floor at 44px. The switch here is a
 *    visually-24px track inside a 44px label, so the hit area meets the floor
 *    without the control looking oversized.
 *  - **The hint was not attached to the control.** It sat in a sibling `<p>`,
 *    so a screen reader read the label ("Record classes automatically") and never
 *    the sentence explaining what turning it on does. `aria-describedby` wires
 *    them together here, once.
 *  - **No visible state but a toast.** These forms post on change, so the only
 *    confirmation was a toast that has usually faded by the time the eye gets
 *    back to the row. `status` renders an inline line under the control.
 *
 * Still a native checkbox, deliberately: every caller submits it through
 * `form.requestSubmit()` and reads it out of `FormData`, which a `role="switch"`
 * button would silently break.
 */
export function ToggleField({
  name,
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
  status,
  className,
}: {
  name: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  /** One sentence on what turning this on actually does. */
  hint?: ReactNode;
  disabled?: boolean;
  /** Inline save feedback — normally a `<FormStatus />`. */
  status?: ReactNode;
  className?: string;
}) {
  const inputId = useId();
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <label htmlFor={inputId} className="block text-sm font-medium">
            {label}
          </label>
          {hint ? (
            <p id={hintId} className="text-sm text-muted-foreground">
              {hint}
            </p>
          ) : null}
        </div>

        {/* The label is the 44px target; the track and thumb are drawn inside
            it. Both are siblings of the input rather than nested, because
            `peer-checked:` compiles to a sibling combinator and silently does
            nothing across a parent boundary. */}
        <label
          htmlFor={inputId}
          className="relative inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center"
        >
          <input
            id={inputId}
            name={name}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-describedby={hintId}
            onChange={(e) => onCheckedChange(e.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="h-6 w-11 rounded-full border border-input bg-muted ring-offset-background transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-3 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:opacity-50"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-0.5 h-5 w-5 -translate-y-1/2 rounded-full bg-background shadow-brand-sm transition-transform peer-checked:translate-x-5 peer-disabled:opacity-50"
          />
        </label>
      </div>
      {status}
    </div>
  );
}
