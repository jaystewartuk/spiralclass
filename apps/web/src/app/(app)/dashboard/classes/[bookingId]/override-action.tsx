"use client";

import { useActionState, useId, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/components/locale-provider";

// Generic one-tap override button. Opens in an accessible dialog
// with focus trap + Escape. Each instance is bound to a server action.
//
// `action` may be either an OverrideState or CancelState reducer; the
// shared shape ({ error?, ok? }) means a single useActionState handles both.

// OverrideState and CancelState share { error?, ok? } so a single reducer
// type covers both.
type SharedState = { error?: string; ok?: string } | undefined;

export type OverrideActionProps = {
  action: (prev: SharedState, formData: FormData) => Promise<SharedState>;
  triggerLabel: string;
  confirmLabel: string;
  description?: string;
  variant?: "default" | "outline" | "destructive";
  // Hidden inputs (booking/package/student id, etc.).
  hiddenInputs: Record<string, string>;
  // Extra inputs rendered above the reason textarea (e.g., new expiration
  // date, custom price field).
  children?: React.ReactNode;
  reasonLabel?: string;
  reasonPlaceholder?: string;
};

export function OverrideAction(props: OverrideActionProps) {
  const t = useT();
  const reasonId = useId();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<SharedState, FormData>(
    props.action,
    undefined,
  );

  const successMsg = state?.ok;
  const errorMsg = state?.error;

  // Close the dialog automatically on success.
  useEffect(() => {
    if (successMsg) {
      setOpen(false);
    }
  }, [successMsg]);

  return (
    <div className="space-y-1">
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button type="button" variant={props.variant ?? "outline"}>
            {props.triggerLabel}
          </Button>
        }
        title={props.triggerLabel}
        description={props.description}
        footer={(close) => (
          <div className="flex w-full flex-col gap-2">
            {errorMsg && (
              <p role="alert" className="text-sm text-destructive">
                {errorMsg}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="submit"
                form={formId}
                variant={props.variant ?? "default"}
                disabled={pending}
              >
                {pending ? t("web.dashboard.classes.override.processing") : props.confirmLabel}
              </Button>
              <Button type="button" variant="ghost" onClick={close} disabled={pending}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      >
        <form id={formId} action={formAction} className="space-y-3">
          {Object.entries(props.hiddenInputs).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          {props.children}
          <div className="space-y-1">
            <Label htmlFor={reasonId}>
              {props.reasonLabel ?? t("web.dashboard.classes.override.reasonLabel")}
            </Label>
            <Textarea
              id={reasonId}
              name="reason"
              required
              minLength={3}
              maxLength={500}
              placeholder={
                props.reasonPlaceholder ?? t("web.dashboard.classes.override.reasonPlaceholder")
              }
            />
          </div>
        </form>
      </ConfirmDialog>
      {successMsg && (
        <p role="status" className="text-sm text-success">
          {successMsg}
        </p>
      )}
    </div>
  );
}
