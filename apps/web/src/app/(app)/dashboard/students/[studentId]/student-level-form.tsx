"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setStudentLevel, type LevelFormState } from "@/app/actions/levels";
import { useT } from "@/components/locale-provider";

// Phase 2 — teacher assigns a student's level. The level drives which library
// items the student can browse (their level and below). Radix Select doesn't
// post a form value, so we mirror the custom-price-form pattern: a controlled
// select writes a hidden input the server action reads. "none" = clear it.

const NONE = "none";

type LevelOption = { id: string; label: string };

export function StudentLevelForm({
  studentId,
  currentLevelId,
  levels,
}: {
  studentId: string;
  currentLevelId: string | null;
  levels: LevelOption[];
}) {
  const t = useT();
  const [selected, setSelected] = useState<string>(currentLevelId ?? NONE);
  const [state, formAction, pending] = useActionState<LevelFormState, FormData>(
    setStudentLevel,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="levelId" value={selected === NONE ? "" : selected} />

      <div className="space-y-1">
        <Label htmlFor="studentLevel">{t("web.studentLevel.label")}</Label>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger id="studentLevel" className="max-w-xs">
            <SelectValue placeholder={t("web.studentLevel.notSet")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("web.studentLevel.notSet")}</SelectItem>
            {levels.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{t("web.studentLevel.hint")}</p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? t("web.studentLevel.saving") : t("common.save")}
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
