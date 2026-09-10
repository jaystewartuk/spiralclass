"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useLocale, useT } from "@/components/locale-provider";
import {
  requestTeacherDeletionAction,
  cancelTeacherDeletionAction,
  requestStudentDeletionAction,
  cancelStudentDeletionAction,
} from "@/app/actions/account-deletion";

// Two states: no pending request → show "Delete" button with a typed
// confirmation; pending request → show "Cancel deletion" with the
// scheduled date. Used from both the teacher and student account
// pages — the `subjectType` prop picks the right server action.

type Props = {
  subjectType: "teacher" | "student";
  pending: { id: string; scheduledFor: string } | null;
};

export function AccountDeletionForm({ subjectType, pending }: Props) {
  const t = useT();
  const locale = useLocale();
  const en = locale === "en";
  const isPending = pending !== null;
  const requestAction =
    subjectType === "teacher" ? requestTeacherDeletionAction : requestStudentDeletionAction;
  const cancelAction =
    subjectType === "teacher" ? cancelTeacherDeletionAction : cancelStudentDeletionAction;

  const [requestState, requestFormAction, requestSubmitting] = useActionState(
    requestAction,
    undefined,
  );
  const [, cancelFormAction, cancelSubmitting] = useActionState(cancelAction, undefined);

  const [confirmText, setConfirmText] = useState("");
  const CONFIRM_PHRASE = t("web.settings.accountDeletion.confirmPhrase");

  if (isPending) {
    const scheduled = new Date(pending.scheduledFor);
    return (
      <div className="space-y-3">
        <Alert variant="warning">
          <AlertTitle>{t("web.settings.accountDeletion.pendingTitle")}</AlertTitle>
          <AlertDescription>
            {t("web.settings.accountDeletion.pendingBodyBefore")}
            <span className="font-medium">
              {scheduled.toLocaleDateString(en ? "en-US" : "es-MX", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </span>
            {t("web.settings.accountDeletion.pendingBodyAfter")}
          </AlertDescription>
        </Alert>
        <form action={cancelFormAction}>
          <Button type="submit" variant="outline" disabled={cancelSubmitting}>
            {t("web.settings.accountDeletion.cancelDeletion")}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <ConfirmDialog
      trigger={
        <Button variant="destructive">{t("web.settings.accountDeletion.deleteMyAccount")}</Button>
      }
      title={t("web.settings.accountDeletion.deleteTitle")}
      footer={(close) => (
        <>
          <Button
            type="submit"
            form="account-deletion-form"
            variant="destructive"
            disabled={confirmText !== CONFIRM_PHRASE || requestSubmitting}
          >
            {t("web.settings.accountDeletion.deleteMyAccount")}
          </Button>
          <Button type="button" variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
        </>
      )}
    >
      <form id="account-deletion-form" action={requestFormAction} className="space-y-3">
        <p className="text-sm">{t("web.settings.accountDeletion.body")}</p>
        <div className="space-y-1">
          <Label htmlFor="confirm">
            {t("web.settings.accountDeletion.confirmLabel")}
            <code className="rounded bg-muted px-1 py-0.5">{CONFIRM_PHRASE}</code>
          </Label>
          <Input
            id="confirm"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className="max-w-xs"
            autoComplete="off"
          />
        </div>
        {requestState?.error ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {requestState.error}
          </p>
        ) : null}
      </form>
    </ConfirmDialog>
  );
}
