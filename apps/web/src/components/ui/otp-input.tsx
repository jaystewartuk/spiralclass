"use client";

import * as React from "react";
import { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS } from "input-otp";
import { cn } from "@/lib/utils";
import { useT } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";

// A 6-digit verification-code field styled after Stripe's segmented OTP
// input (two groups of 3 boxes separated by a dash, active box highlighted
// with a focus ring) recolored onto our own tokens. `input-otp` drives the
// real accessible input underneath (paste, backspace-across-boxes, SMS/email
// autofill) — this just supplies the slot rendering + our styling.
//
// Supports both call-site shapes already in use: an uncontrolled field posted
// through a hidden input (`name`, inside a plain `<form action={...}>`, same
// pattern as `Combobox`) and a fully controlled field (`value`/`onChange`,
// e.g. admin-mfa-form's disabled-until-6-digits button) — the hidden input
// renders whenever `name` is passed, regardless of which mode is active.
export interface OtpInputProps {
  length?: number;
  name?: string;
  value?: string;
  onChange?: (value: string) => void;
  defaultValue?: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** Fires once per distinct fully-typed/pasted code (not on every re-render). */
  onComplete?: (value: string) => void;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

const GROUP_SIZE = 3;

const OtpInput = React.forwardRef<HTMLInputElement, OtpInputProps>(
  (
    {
      length = 6,
      name,
      value,
      onChange,
      defaultValue = "",
      id,
      disabled,
      invalid,
      autoFocus,
      className,
      onComplete,
      ...aria
    },
    forwardedRef,
  ) => {
    const t = useT();
    const innerRef = React.useRef<HTMLInputElement>(null);
    React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLInputElement);

    const [internal, setInternal] = React.useState(defaultValue);
    const isControlled = value !== undefined;
    const current = isControlled ? value : internal;

    const handleChange = (next: string) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    };

    // Guards against re-firing for the same completed code on unrelated
    // re-renders — only a genuinely new complete value (typed or pasted)
    // triggers it, and clearing/editing the code re-arms it.
    const completedRef = React.useRef<string | null>(null);
    React.useEffect(() => {
      if (current.length === length) {
        if (completedRef.current !== current) {
          completedRef.current = current;
          onComplete?.(current);
        }
      } else {
        completedRef.current = null;
      }
    }, [current, length, onComplete]);

    // Clipboard-read support is feature-detected client-side only (avoids a
    // server/client render mismatch) — a plain OS paste into the field always
    // works regardless, this button just saves the extra long-press/Cmd+V.
    const [canPaste, setCanPaste] = React.useState(false);
    React.useEffect(() => {
      setCanPaste(typeof navigator !== "undefined" && Boolean(navigator.clipboard?.readText));
    }, []);

    async function handlePasteClick() {
      try {
        const text = await navigator.clipboard.readText();
        const digits = text.replace(/\D/g, "").slice(0, length);
        if (digits) handleChange(digits);
        innerRef.current?.focus();
      } catch {
        // Permission denied or unavailable — the field still accepts a
        // normal OS paste (long-press / Cmd+V).
      }
    }

    const groups: number[][] = [];
    for (let i = 0; i < length; i += GROUP_SIZE) {
      groups.push(Array.from({ length: Math.min(GROUP_SIZE, length - i) }, (_, j) => i + j));
    }

    return (
      <div className="flex w-full flex-col items-center gap-4">
        <div className={cn("inline-flex items-center justify-center", disabled && "opacity-50")}>
          <OTPInput
            id={id}
            ref={innerRef}
            maxLength={length}
            value={current}
            onChange={handleChange}
            disabled={disabled}
            autoFocus={autoFocus}
            inputMode="numeric"
            pattern={REGEXP_ONLY_DIGITS}
            autoComplete="one-time-code"
            containerClassName={cn("flex items-center justify-center gap-2", className)}
            {...aria}
          >
            {groups.map((group, gi) => (
              <React.Fragment key={gi}>
                {gi > 0 && (
                  <span aria-hidden="true" className="mx-0.5 text-muted-foreground">
                    –
                  </span>
                )}
                <div className="flex gap-1.5 lg:gap-2">
                  {group.map((slotIndex) => (
                    <OtpSlot key={slotIndex} index={slotIndex} invalid={invalid} />
                  ))}
                </div>
              </React.Fragment>
            ))}
          </OTPInput>
          {name && <input type="hidden" name={name} value={current} />}
        </div>
        {canPaste && (
          <Button
            type="button"
            variant="outline"
            onClick={handlePasteClick}
            disabled={disabled}
            className="w-full max-w-56"
          >
            {t("common.pasteCode")}
          </Button>
        )}
      </div>
    );
  },
);
OtpInput.displayName = "OtpInput";

function OtpSlot({ index, invalid }: { index: number; invalid?: boolean }) {
  const context = React.useContext(OTPInputContext);
  const slot = context.slots[index];
  if (!slot) return null;
  const { char, hasFakeCaret, isActive } = slot;

  return (
    <div
      className={cn(
        "relative flex h-14 w-12 items-center justify-center rounded-lg border border-input bg-background text-xl font-medium tabular-nums ring-offset-background lg:h-12 lg:w-10 lg:text-lg",
        isActive && "z-10 ring-2 ring-ring ring-offset-2",
        invalid && "border-destructive",
        invalid && isActive && "ring-destructive",
      )}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="animate-caret-blink h-4 w-px bg-foreground duration-1000" />
        </div>
      )}
    </div>
  );
}

export { OtpInput };
