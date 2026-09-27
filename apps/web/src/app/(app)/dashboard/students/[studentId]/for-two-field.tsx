"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";

// "This package is for two people" on the record- and edit-package forms
// (D-188). A package the teacher records for two draws from its own credit
// balance, like one bought for two — but nobody confirmed at checkout that the
// second person agrees to lesson insights, so insights capture stays off for
// its classes. The hint says so, because nothing else on the screen would.
export function ForTwoField({
  id,
  defaultChecked = false,
}: {
  id: string;
  defaultChecked?: boolean;
}) {
  const t = useT();
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <div className="flex items-start gap-3">
      <input type="hidden" name="forTwo" value={checked ? "1" : ""} />
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => setChecked(v === true)}
        className="mt-0.5"
        aria-describedby={`${id}-hint`}
      />
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id} className="text-sm">
          {t("web.dashboard.students.package.forTwoLabel")}
        </Label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {t("web.dashboard.students.package.forTwoHint")}
        </p>
      </div>
    </div>
  );
}
