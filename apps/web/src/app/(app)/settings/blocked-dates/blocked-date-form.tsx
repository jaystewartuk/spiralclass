"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, CalendarOff } from "lucide-react";
import { blockedDateSchema, zodFieldErrors } from "@spiralclass/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { useLocale, useT } from "@/components/locale-provider";
import { rangeLength } from "@/lib/blocked-dates/ranges";
import { createBlockedDateAction, type BlockedDateState } from "@/app/actions/blocked-dates";

/**
 * The compose half of the screen: what the calendar selection means, and the
 * button that commits it.
 *
 * The two date fields are CONTROLLED by the parent, so the calendar and the
 * inputs are two views of one selection rather than two places to say the same
 * thing. They stay visible (rather than being replaced by the calendar)
 * because typing a date is faster than paging to it, and because they are what
 * the form still submits with JavaScript unavailable.
 *
 * Inline per-field validation is the canonical pattern: the same shared schema
 * the server action runs, checked on submit so the cross-field "end before
 * start" rule can point at the offending field. The button is never gated on a
 * validity flag — only on `pending`.
 */
export function BlockedDateForm({
  startDate,
  endDate,
  minDate,
  onChangeStart,
  onChangeEnd,
  onBlocked,
  impactCount,
}: {
  startDate: string;
  endDate: string;
  /** Today in the teacher's zone. A block in the past cancels nothing and
   * frees nothing, so the fields refuse one for the same reason the grid does. */
  minDate: string;
  onChangeStart: (ymd: string) => void;
  onChangeEnd: (ymd: string) => void;
  /** Fired once the server has created the block, so the parent can clear the
   * selection and let the new block show through on the grid. */
  onBlocked: () => void;
  /** Classes booked inside the selection. The old screen only reported this
   * AFTER the classes were canceled. */
  impactCount: number;
}) {
  const t = useT();
  const locale = useLocale();
  const [state, formAction, pending] = useActionState<BlockedDateState, FormData>(
    createBlockedDateAction,
    undefined,
  );
  const { errors, setErrors, clearError } = useFieldErrors<"startDate" | "endDate">();
  // Controlled so a completed block can empty it. The dates are cleared by the
  // parent (they are its state); the reason is the form's own.
  const [reason, setReason] = useState("");

  const dayCount =
    startDate && endDate && startDate <= endDate
      ? rangeLength({ start: startDate, end: endDate })
      : 0;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const fd = new FormData(e.currentTarget);
    const parsed = blockedDateSchema(locale).safeParse({
      startDate: fd.get("startDate"),
      endDate: fd.get("endDate"),
      reason: fd.get("reason"),
    });
    if (!parsed.success) {
      e.preventDefault();
      const fe = zodFieldErrors(parsed.error);
      setErrors({ startDate: fe.startDate, endDate: fe.endDate });
    }
  }

  // The action returns a message on success and an error on failure, so the
  // success path is a positive test rather than "not pending and not an
  // error" — which was also true on the very first render, and reset the form
  // out from under a teacher who had typed into it before hydration.
  //
  // Held in a ref because the parent re-creates it every render: as a
  // dependency it would fire the effect on renders where nothing was
  // submitted. `useActionState` yields a fresh state object per completed
  // action, so keying on that alone is once per block.
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;
  useEffect(() => {
    if (!state?.ok) return;
    setReason("");
    onBlockedRef.current();
  }, [state]);

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="startDate">
            {t("web.settings.blockedDates.from")}{" "}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </Label>
          <Input
            id="startDate"
            name="startDate"
            type="date"
            value={startDate}
            min={minDate}
            required
            aria-required="true"
            disabled={pending}
            invalid={Boolean(errors.startDate) || Boolean(state?.error)}
            aria-describedby={
              errors.startDate ? "startDate-error" : state?.error ? "blocked-date-error" : undefined
            }
            onChange={(e) => {
              clearError("startDate");
              onChangeStart(e.target.value);
            }}
          />
          <FieldError id="startDate-error" message={errors.startDate} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="endDate">
            {t("web.settings.blockedDates.to")}{" "}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </Label>
          <Input
            id="endDate"
            name="endDate"
            type="date"
            value={endDate}
            min={startDate || minDate}
            required
            aria-required="true"
            disabled={pending}
            invalid={Boolean(errors.endDate)}
            aria-describedby={errors.endDate ? "endDate-error" : undefined}
            onChange={(e) => {
              clearError("endDate");
              onChangeEnd(e.target.value);
            }}
          />
          <FieldError id="endDate-error" message={errors.endDate} />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="reason">{t("web.settings.blockedDates.reasonLabel")}</Label>
        <Input
          id="reason"
          name="reason"
          type="text"
          maxLength={120}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("web.settings.blockedDates.reasonPlaceholder")}
          disabled={pending}
          aria-describedby="reason-hint"
        />
        <p id="reason-hint" className="text-muted-foreground text-xs">
          {t("web.settings.blockedDates.reasonHint")}
        </p>
      </div>

      {impactCount > 0 && (
        // aria-live because the count changes as the calendar selection does,
        // and the change is the whole warning: a teacher who has just dragged
        // a range over a booked week has to hear it, not only see it.
        <Alert variant="warning" aria-live="polite">
          <AlertTriangle aria-hidden />
          <AlertDescription>
            {t("web.settings.blockedDates.impact", { count: impactCount })}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          <CalendarOff className="h-4 w-4" aria-hidden />
          {pending
            ? t("web.settings.blockedDates.blocking")
            : dayCount > 0
              ? t("web.settings.blockedDates.blockDays", { count: dayCount })
              : // No usable range typed in — "Block 0 days" would be a
                // statement about the selection rather than a label for the
                // button, and pressing it is how the field error appears.
                t("web.settings.blockedDates.block")}
        </Button>
        {/* The success message reports canceled classes — keep it on screen
            instead of fading it like a routine "Saved." tick. */}
        <FormStatus state={state} errorId="blocked-date-error" fade={false} />
      </div>
    </form>
  );
}
