"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  disableTeacherAction,
  enableTeacherAction,
  resendTeacherMagicLinkAction,
  type AdminTeacherActionState,
} from "@/app/actions/admin-teachers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/components/locale-provider";

export function TeacherModerationForm({
  teacherId,
  disabled,
}: {
  teacherId: string;
  disabled: boolean;
}) {
  const t = useT();
  const [disableState, disableAction, disablePending] = useActionState<
    AdminTeacherActionState,
    FormData
  >(disableTeacherAction, undefined);
  const [enableState, enableAction, enablePending] = useActionState<
    AdminTeacherActionState,
    FormData
  >(enableTeacherAction, undefined);
  const [resendState, resendAction, resendPending] = useActionState<
    AdminTeacherActionState,
    FormData
  >(resendTeacherMagicLinkAction, undefined);

  useEffect(() => {
    if (disableState?.error) toast.error(disableState.error);
    else if (disableState && !disableState.error)
      toast.success(t("web.admin.teachers.moderation.disabledToast"));
  }, [disableState, t]);
  useEffect(() => {
    if (enableState?.error) toast.error(enableState.error);
    else if (enableState && !enableState.error)
      toast.success(t("web.admin.teachers.moderation.enabledToast"));
  }, [enableState, t]);
  useEffect(() => {
    if (resendState?.info) toast.success(resendState.info);
    else if (resendState?.error) toast.error(resendState.error);
  }, [resendState]);

  return (
    <div className="space-y-4">
      {disabled ? (
        <form action={enableAction} className="rounded-md border p-4">
          <input type="hidden" name="teacherId" value={teacherId} />
          <p className="mb-3 text-sm text-muted-foreground">
            {t("web.admin.teachers.moderation.reenableHint")}
          </p>
          {enableState?.error && (
            <p className="mb-3 text-sm text-destructive">{enableState.error}</p>
          )}
          <Button type="submit" disabled={enablePending}>
            {enablePending
              ? t("web.admin.teachers.moderation.enabling")
              : t("web.admin.teachers.moderation.reenableSubmit")}
          </Button>
        </form>
      ) : (
        <div className="rounded-md border p-4">
          <ConfirmDialog
            trigger={
              <Button variant="destructive">
                {t("web.admin.teachers.moderation.disableSubmit")}
              </Button>
            }
            title={t("web.admin.teachers.moderation.disableConfirmTitle")}
            footer={(close) => (
              <>
                <Button
                  type="submit"
                  form="disable-teacher-form"
                  variant="destructive"
                  disabled={disablePending}
                >
                  {disablePending
                    ? t("web.admin.teachers.moderation.disabling")
                    : t("web.admin.teachers.moderation.disableSubmit")}
                </Button>
                <Button type="button" variant="ghost" onClick={close}>
                  {t("common.cancel")}
                </Button>
              </>
            )}
          >
            <Alert variant="warning">
              <AlertDescription>
                {t("web.admin.teachers.moderation.disableWarning")}
              </AlertDescription>
            </Alert>
            <form id="disable-teacher-form" action={disableAction} className="space-y-3 pt-2">
              <input type="hidden" name="teacherId" value={teacherId} />
              <div className="space-y-2">
                <Label htmlFor="reason">{t("web.admin.moderation.reasonLabel")}</Label>
                <Input
                  id="reason"
                  name="reason"
                  required
                  maxLength={280}
                  aria-required="true"
                  placeholder={t("web.admin.teachers.moderation.reasonPlaceholder")}
                />
              </div>
              {disableState?.error && (
                <p className="text-sm text-destructive">{disableState.error}</p>
              )}
            </form>
          </ConfirmDialog>
        </div>
      )}

      <form action={resendAction} className="rounded-md border p-4">
        <input type="hidden" name="teacherId" value={teacherId} />
        <p className="mb-3 text-sm text-muted-foreground">
          {t("web.admin.teachers.moderation.resendHint")}
        </p>
        {resendState?.error && <p className="mb-3 text-sm text-destructive">{resendState.error}</p>}
        {resendState?.info && <p className="mb-3 text-sm text-success">{resendState.info}</p>}
        <Button type="submit" variant="outline" disabled={resendPending}>
          {resendPending
            ? t("web.admin.teachers.moderation.sending")
            : t("web.admin.teachers.moderation.resendSubmit")}
        </Button>
      </form>
    </div>
  );
}
