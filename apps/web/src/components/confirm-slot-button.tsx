"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

// Shared slot button for the booking + reschedule pickers (review item 2).
// Tapping a time opens a confirmation dialog that restates the full
// date/time before committing — an accidental tap never books or moves a
// class (a slot within 24h would cost a class on cancel; a reschedule
// burns the single one allowed).
//
// Presentational: the caller owns the typed useActionState and passes its
// uniform dispatch + state here. The form lives inside the dialog (which
// Radix portals out of the page), so the footer's submit button reaches it
// via `form={formId}` — the same wiring the teacher OverrideAction uses. A
// successful action redirects server-side; on error the dialog stays open
// so the student can read it and pick another slot.
export function ConfirmSlotButton({
  formAction,
  hiddenInputs,
  pending,
  error,
  timeLabel,
  secondaryLabel,
  triggerAriaLabel,
  title,
  summary,
  subtitle,
  confirmLabel,
  pendingLabel,
  cancelLabel,
}: {
  formAction: (formData: FormData) => void;
  hiddenInputs: Record<string, string>;
  pending: boolean;
  error?: string;
  // Compact time shown on the grid button, e.g. "9:00".
  timeLabel: string;
  /**
   * A second, quieter line on the GRID button — the other party's local time
   * when the two zones differ ("3:00 p.m. for Marcela"). Absent when they
   * match, because repeating the same clock twice is noise on every slot.
   *
   * On the button rather than only in the dialog: booking across zones is the
   * one mistake this screen can make that nobody notices until the class is
   * missed, and a confirmation the teacher reaches by tapping the wrong time
   * is a confirmation of the wrong time.
   */
  secondaryLabel?: string;
  triggerAriaLabel: string;
  title: string;
  // Full restated date + time, e.g. "jue, 12 jun, 9:00 a.m.".
  summary: string;
  // Optional second line, e.g. "30 min · Alicia Moreno".
  subtitle?: string;
  confirmLabel: string;
  pendingLabel: string;
  cancelLabel: string;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          type="button"
          variant="outline"
          // Two lines need `h-auto`, and `min-h-target` keeps the 44px floor
          // (D-140) that dropping the fixed height would otherwise remove.
          className={cn(
            "w-full",
            secondaryLabel && "min-h-target h-auto flex-col gap-0.5 py-2 leading-tight",
          )}
          aria-label={triggerAriaLabel}
        >
          <span className="font-semibold">{timeLabel}</span>
          {/* Hierarchy by colour and weight, not size: the type scale floors
              supporting text at 15px, which is where this line already is. */}
          {secondaryLabel ? (
            <span className="text-muted-foreground text-xs font-normal">{secondaryLabel}</span>
          ) : null}
        </Button>
      }
      title={title}
      footer={() => (
        <div className="flex w-full flex-col gap-2">
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" form={formId} disabled={pending}>
              {pending ? pendingLabel : confirmLabel}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              {cancelLabel}
            </Button>
          </div>
        </div>
      )}
    >
      <div className="bg-muted/30 rounded-md border px-3 py-2">
        <p className="font-medium">{summary}</p>
        {subtitle && <p className="text-muted-foreground text-sm">{subtitle}</p>}
      </div>
      <form id={formId} action={formAction} className="hidden">
        {Object.entries(hiddenInputs).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
      </form>
    </ConfirmDialog>
  );
}
