"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  disableStudentAction,
  enableStudentAction,
  type AdminStudentActionState,
} from "@/app/actions/admin-students";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/components/locale-provider";

export function StudentModerationForm({
  studentId,
  disabled,
}: {
  studentId: string;
  disabled: boolean;
}) {
  const t = useT();
  const [disableState, disableAction, disablePending] = useActionState<
    AdminStudentActionState,
    FormData
  >(disableStudentAction, undefined);
  const [enableState, enableAction, enablePending] = useActionState<
    AdminStudentActionState,
    FormData
  >(enableStudentAction, undefined);

  useEffect(() => {
    if (disableState?.error) toast.error(disableState.error);
    else if (disableState && !disableState.error)
      toast.success(t("web.admin.students.moderation.disabledToast"));
  }, [disableState, t]);
  useEffect(() => {
    if (enableState?.error) toast.error(enableState.error);
    else if (enableState && !enableState.error)
      toast.success(t("web.admin.students.moderation.enabledToast"));
  }, [enableState, t]);

  if (disabled) {
    return (
      <form action={enableAction} className="rounded-md border p-4">
        <input type="hidden" name="studentId" value={studentId} />
        <p className="text-muted-foreground mb-3 text-sm">
          {t("web.admin.students.moderation.reenableHint")}
        </p>
        {enableState?.error && <p className="text-destructive mb-3 text-sm">{enableState.error}</p>}
        <Button type="submit" disabled={enablePending}>
          {enablePending
            ? t("web.admin.students.moderation.enabling")
            : t("web.admin.students.moderation.reenableSubmit")}
        </Button>
      </form>
    );
  }

  return (
    <div className="rounded-md border p-4">
      <ConfirmDialog
        trigger={
          <Button variant="destructive">{t("web.admin.students.moderation.disableSubmit")}</Button>
        }
        title={t("web.admin.students.moderation.disableConfirmTitle")}
        footer={(close) => (
          <>
            <Button
              type="submit"
              form="disable-student-form"
              variant="destructive"
              disabled={disablePending}
            >
              {disablePending
                ? t("web.admin.students.moderation.disabling")
                : t("web.admin.students.moderation.disableSubmit")}
            </Button>
            <Button type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
          </>
        )}
      >
        <Alert variant="warning">
          <AlertDescription>{t("web.admin.students.moderation.disableWarning")}</AlertDescription>
        </Alert>
        <form id="disable-student-form" action={disableAction} className="space-y-3 pt-2">
          <input type="hidden" name="studentId" value={studentId} />
          <div className="space-y-2">
            <Label htmlFor="reason">{t("web.admin.moderation.reasonLabel")}</Label>
            <Input
              id="reason"
              name="reason"
              required
              maxLength={280}
              aria-required="true"
              placeholder={t("web.admin.students.moderation.reasonPlaceholder")}
            />
          </div>
          {disableState?.error && <p className="text-destructive text-sm">{disableState.error}</p>}
        </form>
      </ConfirmDialog>
    </div>
  );
}
