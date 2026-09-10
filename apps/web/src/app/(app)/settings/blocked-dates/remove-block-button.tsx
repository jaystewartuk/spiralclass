"use client";

import { Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, type ButtonProps } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { useT } from "@/components/locale-provider";
import { deleteBlockedDateAction } from "@/app/actions/blocked-dates";

/**
 * Remove one block, behind a confirmation.
 *
 * Confirmed because removing is NOT the inverse of blocking: the days come
 * back and students can book them again, but the classes the block canceled
 * stay canceled. That is the sentence in the dialog, and it is the one thing a
 * teacher cannot discover by trying it.
 *
 * Shared by the list and by the "already blocked" notice in the composer, so
 * the two offer the same dialog rather than two spellings of it. The dialog is
 * never closed by hand on success: the action revalidates, the row unmounts,
 * and the portal goes with it — a failed action leaves everything as it was.
 */
export function RemoveBlockButton({
  blockId,
  range,
  size = "sm",
  variant = "ghost",
}: {
  blockId: string;
  /** The formatted range — named in the trigger's accessible name and in the
   * dialog, so a column of identical "Remove" buttons is still navigable. */
  range: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
}) {
  const t = useT();

  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant={variant}
          size={size}
          aria-label={t("web.settings.blockedDates.removeLabel", { range })}
          className="text-destructive hover:bg-destructive-bg hover:text-destructive gap-1.5"
        >
          <Trash2 className="size-4" aria-hidden />
          {t("web.settings.blockedDates.remove")}
        </Button>
      }
      title={t("web.settings.blockedDates.removeTitle")}
      description={range}
      footer={(close) => (
        // The form wraps only the confirm button so `useFormStatus` — which
        // reads the nearest ancestor form — sees this submit and nothing else.
        <form action={deleteBlockedDateAction} className="flex w-full flex-wrap gap-2">
          <input type="hidden" name="id" value={blockId} />
          <SubmitButton variant="destructive" className="gap-1.5">
            <Trash2 className="size-4" aria-hidden />
            {t("web.settings.blockedDates.removeConfirm")}
          </SubmitButton>
          <Button type="button" variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
        </form>
      )}
    >
      <Alert variant="warning">
        <AlertDescription>{t("web.settings.blockedDates.removeBody", { range })}</AlertDescription>
      </Alert>
    </ConfirmDialog>
  );
}
