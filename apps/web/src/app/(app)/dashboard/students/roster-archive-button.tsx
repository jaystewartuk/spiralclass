"use client";

import { useActionState, useState } from "react";
import { UserMinus } from "lucide-react";
import { toggleStudentArchive, type OverrideState } from "@/app/actions/overrides";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

// "Dar de baja" from the list itself. It only ever lived on each student's
// settings tab, where a teacher tidying her list did not think to look. A real
// dialog rather than the settings form's confirm(), because this one has to show
// what archiving would cost this particular student. Labels arrive as props: the
// list is a Server Component that already holds the translator.
export function RosterArchiveButton({
  studentId,
  name,
  label,
  description,
  warning,
  cancelLabel,
}: {
  studentId: string;
  name: string;
  label: string;
  description: string;
  warning: string | null;
  cancelLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<OverrideState, FormData>(
    async (previous, formData) => {
      const result = await toggleStudentArchive(previous, formData);
      if (result?.ok) setOpen(false);
      return result;
    },
    undefined,
  );

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${label}: ${name}`}
          className="text-muted-foreground"
        >
          <UserMinus className="size-4" aria-hidden />
          <span className="hidden lg:inline">{label}</span>
        </Button>
      }
      title={name}
      description={description}
      footer={(close) => (
        <form action={formAction} className="flex justify-end gap-2">
          <input type="hidden" name="studentId" value={studentId} />
          <input type="hidden" name="intent" value="archive" />
          <Button type="button" variant="outline" size="sm" onClick={close}>
            {cancelLabel}
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "..." : label}
          </Button>
        </form>
      )}
    >
      {warning && <p className="text-sm font-medium text-warning">{warning}</p>}
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </ConfirmDialog>
  );
}
