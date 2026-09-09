"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { assignLibraryMaterialAction, type AssignMaterialState } from "@/app/actions/library";
import { useT } from "@/components/locale-provider";

// Phase 5 — assign a library item to this student. Only items not already
// assigned are offered; submitting posts to the server action, and any
// failure is shown inline (the action used to fail silently — review
// item 8).

type Option = { id: string; label: string };

export function AssignMaterialForm({
  studentId,
  options,
}: {
  studentId: string;
  options: Option[];
}) {
  const t = useT();
  const [materialId, setMaterialId] = useState<string>("");
  const [pickError, setPickError] = useState<string | undefined>(undefined);
  const [state, formAction, pending] = useActionState<AssignMaterialState, FormData>(
    assignLibraryMaterialAction,
    undefined,
  );

  // Clear the picker after a successful assign so the next pick starts fresh.
  useEffect(() => {
    if (state?.ok) setMaterialId("");
  }, [state]);

  if (options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("web.dashboard.students.material.allAssigned")}
      </p>
    );
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    if (!materialId) {
      e.preventDefault();
      setPickError(t("web.dashboard.students.material.chooseOne"));
    }
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="studentId" value={studentId} />
        <input type="hidden" name="materialId" value={materialId} />
        <Select
          value={materialId}
          onValueChange={(v) => {
            setMaterialId(v);
            setPickError(undefined);
          }}
        >
          <SelectTrigger className="min-w-64" aria-invalid={Boolean(pickError) || undefined}>
            <SelectValue placeholder={t("web.dashboard.students.material.choosePlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={pending}>
          {pending
            ? t("web.dashboard.students.material.assigning")
            : t("web.dashboard.students.material.assign")}
        </Button>
      </div>
      {pickError && (
        <p role="alert" aria-live="polite" className="text-sm text-destructive">
          {pickError}
        </p>
      )}
      {state?.error && (
        <p role="alert" aria-live="polite" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
