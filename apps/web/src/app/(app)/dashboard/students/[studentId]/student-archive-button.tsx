"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toggleStudentArchive, type OverrideState } from "@/app/actions/overrides";
import { useT } from "@/components/locale-provider";

// Teacher-facing "dar de baja" / reactivate for a single roster link. Archiving
// parks the student on this teacher's roster (and silences lifecycle
// notifications) without touching bookings, packages or login. Reversible.
// The server action re-checks ownership and the current archived state.
export function StudentArchiveButton({
  studentId,
  archived,
}: {
  studentId: string;
  archived: boolean;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<OverrideState, FormData>(
    toggleStudentArchive,
    undefined,
  );
  const intent = archived ? "reactivate" : "archive";
  const label = archived
    ? t("web.dashboard.students.archive.reactivate")
    : t("web.dashboard.students.archive.archive");

  return (
    <form
      action={formAction}
      className="space-y-3"
      onSubmit={(e) => {
        const message = archived
          ? t("web.dashboard.students.archive.confirmReactivate")
          : t("web.dashboard.students.archive.confirmArchive");
        if (!confirm(message)) e.preventDefault();
      }}
    >
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="intent" value={intent} />

      {!archived && (
        <div className="space-y-1">
          <Textarea
            name="reason"
            maxLength={500}
            placeholder={t("web.dashboard.students.archive.reasonPlaceholder")}
          />
        </div>
      )}

      <Button type="submit" variant={archived ? "default" : "outline"} size="sm" disabled={pending}>
        {pending ? "..." : label}
      </Button>

      {state?.error && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="text-success text-sm">
          {state.ok}
        </p>
      )}
    </form>
  );
}
