"use client";

import { useActionState, type FormEvent } from "react";
import { signInSchema, zodFieldErrors } from "@spiralclass/shared";
import {
  inviteAdminAction,
  toggleAdminDisabledAction,
  updateAdminRoleAction,
  type AdminStaffActionState,
} from "@/app/actions/admin-staff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { useT } from "@/components/locale-provider";
import type { AdminRole } from "@prisma/client";

const ROLES: AdminRole[] = ["superadmin", "finance", "support", "tester", "engineer"];

export function InviteForm() {
  const t = useT();
  const [state, action, pending] = useActionState<AdminStaffActionState, FormData>(
    inviteAdminAction,
    undefined,
  );
  // Inline per-field validation (canonical form pattern): keep the submit
  // button enabled and validate on submit via the shared email schema — a
  // guard-safe, localized message source — instead of gating the button.
  // React 19 honours preventDefault in onSubmit, so an invalid form never
  // dispatches the server action, which still validates on its own.
  const { errors, setErrors, clearError } = useFieldErrors<"email">();
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    const parsed = signInSchema().safeParse({ email });
    if (!parsed.success) {
      e.preventDefault();
      setErrors({ email: zodFieldErrors(parsed.error).email });
    }
  }
  return (
    <form
      action={action}
      onSubmit={handleSubmit}
      noValidate
      className="bg-muted/30 space-y-3 rounded-md border p-4"
    >
      <h3 className="text-sm font-semibold">{t("web.admin.staff.addAdmin")}</h3>
      <div className="grid gap-3 lg:grid-cols-[2fr_1fr_auto] lg:items-end">
        <div className="space-y-1">
          <Label htmlFor="invite-email">{t("common.email")}</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "invite-email-error" : undefined}
            onChange={() => clearError("email")}
          />
          <FieldError id="invite-email-error" message={errors.email} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="invite-role">{t("web.admin.staff.role")}</Label>
          <select
            id="invite-role"
            name="role"
            required
            defaultValue="support"
            className="bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "…" : t("web.admin.staff.add")}
        </Button>
      </div>
      {state?.error && <p className="text-destructive text-sm">{state.error}</p>}
      {state?.ok && <p className="text-success text-sm">{t("web.admin.staff.added")}</p>}
    </form>
  );
}

export function RoleSelect({
  adminId,
  currentRole,
  selfDisabled,
}: {
  adminId: string;
  currentRole: AdminRole;
  selfDisabled: boolean;
}) {
  const t = useT();
  const [state, action, pending] = useActionState<AdminStaffActionState, FormData>(
    updateAdminRoleAction,
    undefined,
  );
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="adminId" value={adminId} />
      <select
        name="role"
        defaultValue={currentRole}
        disabled={pending || selfDisabled}
        className="bg-background h-8 rounded-md border px-2 text-sm"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={pending || selfDisabled}>
        {t("common.save")}
      </Button>
      {state?.error && <span className="text-destructive text-xs">{state.error}</span>}
    </form>
  );
}

export function ToggleDisabledButton({
  adminId,
  isDisabled,
  selfDisabled,
}: {
  adminId: string;
  isDisabled: boolean;
  selfDisabled: boolean;
}) {
  const t = useT();
  const [state, action, pending] = useActionState<AdminStaffActionState, FormData>(
    toggleAdminDisabledAction,
    undefined,
  );
  return (
    <form action={action} className="inline">
      <input type="hidden" name="adminId" value={adminId} />
      <input type="hidden" name="disable" value={isDisabled ? "false" : "true"} />
      <Button
        type="submit"
        size="sm"
        variant={isDisabled ? "outline" : "destructive"}
        disabled={pending || selfDisabled}
      >
        {pending ? "…" : isDisabled ? t("web.admin.staff.enable") : t("web.admin.staff.disable")}
      </Button>
      {state?.error && <span className="text-destructive ml-2 text-xs">{state.error}</span>}
    </form>
  );
}
