"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { deleteManualPackageAction, type ManualPackageState } from "@/app/actions/teacher-packages";
import { useT } from "@/components/locale-provider";

// Permanently delete a package created by accident. Only rendered for a package
// with no booked classes and no payment on record (the student detail page
// decides) — the case where a manual entry was a genuine mistake. Destructive
// and irreversible, so it sits behind a confirm dialog; the server action
// re-checks ownership and the same no-history guard. On success the dialog
// closes (and the package row unmounts on revalidation); a guard failure shows
// its error inside the still-open dialog.
export function DeletePackageButton({ packageId }: { packageId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ManualPackageState, FormData>(
    deleteManualPackageAction,
    undefined,
  );
  const formId = `delete-package-${packageId}`;

  // Close the dialog automatically once the delete succeeds, matching the
  // teacher OverrideAction convention.
  useEffect(() => {
    if (state?.ok) setOpen(false);
  }, [state?.ok]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="sm" className="text-destructive">
          {t("common.delete")}
        </Button>
      }
      title={t("web.dashboard.students.package.deleteTitle")}
      footer={(close) => (
        <div className="flex w-full flex-col gap-2">
          {state?.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" form={formId} variant="destructive" disabled={pending}>
              {pending
                ? t("web.dashboard.students.package.deleting")
                : t("web.dashboard.students.package.deletePackage")}
            </Button>
            <Button type="button" variant="ghost" onClick={close} disabled={pending}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    >
      <Alert variant="warning">
        <AlertDescription>{t("web.dashboard.students.package.deleteBody")}</AlertDescription>
      </Alert>
      <form id={formId} action={formAction} className="pt-2">
        <input type="hidden" name="packageId" value={packageId} />
      </form>
    </ConfirmDialog>
  );
}
