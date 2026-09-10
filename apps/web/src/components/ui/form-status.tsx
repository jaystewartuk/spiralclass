"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared status line for forms driven by useActionState. Errors render in
// the destructive tone; success renders in the theme `success` tone with a
// check mark. Routine "Saved." confirmations fade out after a few seconds so
// a stale "Saved." can't sit next to edits made minutes later — pass
// fade={false} when the success message carries information worth keeping
// (e.g. "we canceled 2 classes").
type FormStatusState = { ok?: boolean | string; error?: string } | null | undefined;

const FADE_AFTER_MS = 4000;

export function FormStatus({
  state,
  savedMessage,
  errorId,
  fade = true,
  className,
  pending = false,
  savingMessage,
}: {
  state: FormStatusState;
  /** Success text when state.ok is not itself a message. */
  savedMessage?: string;
  /** id for the error line, for aria-describedby wiring on the field. */
  errorId?: string;
  fade?: boolean;
  className?: string;
  /**
   * For buttonless auto-save forms: when `pending` is true and a
   * `savingMessage` is given, the line shows an in-progress state instead of a
   * (button-less) form leaving no feedback while the action runs.
   */
  pending?: boolean;
  savingMessage?: string;
}) {
  const [showSuccess, setShowSuccess] = useState(false);

  // Keyed on the state object: useActionState yields a fresh object per
  // completed action, so the confirmation re-appears on every save.
  useEffect(() => {
    if (!state?.ok || state.error) return;
    setShowSuccess(true);
    if (!fade) return;
    const t = setTimeout(() => setShowSuccess(false), FADE_AFTER_MS);
    return () => clearTimeout(t);
  }, [state, fade]);

  if (pending && savingMessage) {
    return (
      <p
        role="status"
        aria-live="polite"
        className={cn("text-muted-foreground text-sm", className)}
      >
        {savingMessage}
      </p>
    );
  }

  if (state?.error) {
    return (
      <p
        id={errorId}
        role="alert"
        aria-live="polite"
        className={cn("text-destructive text-sm", className)}
      >
        {state.error}
      </p>
    );
  }

  let message: string | undefined;
  if (state?.ok) {
    message = typeof state.ok === "string" ? state.ok : savedMessage;
  }
  if (!message || !showSuccess) return null;

  return (
    <p
      role="status"
      aria-live="polite"
      className={cn("text-success flex items-center gap-1.5 text-sm", className)}
    >
      <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}
