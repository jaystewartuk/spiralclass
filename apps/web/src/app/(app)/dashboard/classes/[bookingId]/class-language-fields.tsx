"use client";

import { useState } from "react";
import { languageOptions } from "@spiralclass/shared";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocale, useT } from "@/components/locale-provider";

// Two language selects for the per-booking caption override (D-27) — meant to
// be used as OverrideAction's `children`. "Use default" (empty value) clears
// the override for that side, falling back to the teacher/student's own
// default language (see class-access.ts's resolution order).
const USE_DEFAULT = "__default__";

export function ClassLanguageFields({
  currentTeacherLanguage,
  currentStudentLanguage,
}: {
  // null when unset (falls back to the default) — pre-select "Use default".
  currentTeacherLanguage: string | null;
  currentStudentLanguage: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const [teacherLanguage, setTeacherLanguage] = useState(currentTeacherLanguage ?? USE_DEFAULT);
  const [studentLanguage, setStudentLanguage] = useState(currentStudentLanguage ?? USE_DEFAULT);

  return (
    <div className="space-y-3">
      <input
        type="hidden"
        name="teacherLanguage"
        value={teacherLanguage === USE_DEFAULT ? "" : teacherLanguage}
      />
      <input
        type="hidden"
        name="studentLanguage"
        value={studentLanguage === USE_DEFAULT ? "" : studentLanguage}
      />
      <div className="space-y-1">
        <Label htmlFor="teacherLanguageSelect">
          {t("web.dashboard.classes.detail.language.teacherLabel")}
        </Label>
        <Select value={teacherLanguage} onValueChange={setTeacherLanguage}>
          <SelectTrigger id="teacherLanguageSelect" className="max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={USE_DEFAULT}>
              {t("web.dashboard.classes.detail.language.useDefault")}
            </SelectItem>
            {languageOptions(locale, { captionsOnly: true }).map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="studentLanguageSelect">
          {t("web.dashboard.classes.detail.language.studentLabel")}
        </Label>
        <Select value={studentLanguage} onValueChange={setStudentLanguage}>
          <SelectTrigger id="studentLanguageSelect" className="max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={USE_DEFAULT}>
              {t("web.dashboard.classes.detail.language.useDefault")}
            </SelectItem>
            {languageOptions(locale, { captionsOnly: true }).map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
