"use client";

import { useActionState, useEffect, type FormEvent } from "react";
import { toast } from "sonner";
import { signInSchema, zodFieldErrors } from "@spiralclass/shared";
import {
  adminChangeStudentEmailAction,
  type AdminStudentActionState,
} from "@/app/actions/admin-students";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { useT } from "@/components/locale-provider";

// Support path of the verified email change: used when the student can't
// run the self-service flow (lost old inbox + session). Moves the Supabase
// auth identity and the Student row(s) together; the old and new addresses
// are notified. Verify the requester's identity out-of-band first.

export function StudentEmailForm({
  studentId,
  currentEmail,
  hasLogin,
}: {
  studentId: string;
  currentEmail: string | null;
  hasLogin: boolean;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<AdminStudentActionState, FormData>(
    adminChangeStudentEmailAction,
    undefined,
  );
  // Inline per-field validation (canonical form pattern): the new-email field
  // is validated on submit via the shared email schema (guard-safe, localized),
  // keeping the submit button enabled instead of gating it. The server action
  // still validates on its own; React 19 honours preventDefault here.
  const { errors, setErrors, clearError } = useFieldErrors<"newEmail">();
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const email = String(new FormData(e.currentTarget).get("newEmail") ?? "");
    const parsed = signInSchema().safeParse({ email });
    if (!parsed.success) {
      e.preventDefault();
      setErrors({ newEmail: zodFieldErrors(parsed.error).email });
    }
  }

  useEffect(() => {
    if (state?.error) toast.error(state.error);
    else if (state?.ok) toast.success(t("web.admin.students.emailForm.updated"));
  }, [state, t]);

  return (
    <form
      action={formAction}
      onSubmit={handleSubmit}
      noValidate
      className="space-y-3 rounded-md border p-4"
    >
      <div>
        <h2 className="text-sm font-semibold">{t("web.admin.students.emailForm.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {hasLogin
            ? t("web.admin.students.emailForm.hintHasLogin")
            : t("web.admin.students.emailForm.hintNoLogin")}
        </p>
      </div>
      <input type="hidden" name="studentId" value={studentId} />
      <div className="space-y-2">
        <Label htmlFor="admin-new-email">{t("web.admin.students.emailForm.newEmail")}</Label>
        <Input
          id="admin-new-email"
          name="newEmail"
          type="email"
          required
          maxLength={254}
          defaultValue=""
          placeholder={currentEmail ?? "new@email.com"}
          invalid={Boolean(errors.newEmail)}
          aria-describedby={errors.newEmail ? "admin-new-email-error" : undefined}
          onChange={() => clearError("newEmail")}
        />
        <FieldError id="admin-new-email-error" message={errors.newEmail} />
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" disabled={pending}>
        {pending
          ? t("web.admin.students.emailForm.updating")
          : t("web.admin.students.emailForm.submit")}
      </Button>
    </form>
  );
}
