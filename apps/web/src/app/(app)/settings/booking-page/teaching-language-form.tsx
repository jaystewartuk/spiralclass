"use client";

import { useActionState, useState, startTransition } from "react";
import { languageOptions } from "@spiralclass/shared";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocale, useT } from "@/components/locale-provider";
import { saveTeachingLanguageAction, type ProfileState } from "@/app/actions/profile";

// Live-caption default (D-27): the language this teacher teaches IN — the
// ASR/translation source unless a specific class overrides it (see the
// per-booking language control on the class detail page). A fixed ~12-option
// list, so a plain Select rather than the searchable Combobox.
//
// Sits beside the "language you teach" picker on the booking-page settings so
// the two related-but-distinct language fields are configured together, with
// clearly separated labels. Auto-saves on selection (no Save button) — a single
// discrete choice needs no explicit commit.
export function TeachingLanguageForm({ initialLanguage }: { initialLanguage: string }) {
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<string>(initialLanguage);
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(
    saveTeachingLanguageAction,
    undefined,
  );

  function onValueChange(value: string) {
    setSelected(value);
    const data = new FormData();
    data.set("teachingLanguage", value);
    startTransition(() => formAction(data));
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="teachingLanguage">{t("web.settings.teachingLanguage.label")}</Label>
        <Select value={selected} onValueChange={onValueChange}>
          <SelectTrigger id="teachingLanguage" className="max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languageOptions(locale, { captionsOnly: true }).map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{t("web.settings.teachingLanguage.hint")}</p>
      </div>
      <FormStatus
        state={state}
        pending={pending}
        savingMessage={t("web.settings.saving")}
        savedMessage={t("web.settings.teachingLanguage.savedMessage")}
      />
    </div>
  );
}
