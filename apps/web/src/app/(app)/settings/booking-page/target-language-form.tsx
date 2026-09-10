"use client";

import { useActionState, useMemo, useState, startTransition } from "react";
import { languageOptions } from "@spiralclass/shared";
import { Combobox } from "@/components/ui/combobox";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { useLocale, useT } from "@/components/locale-provider";
import { saveTargetLanguageAction, type ProfileState } from "@/app/actions/profile";

// The language this teacher teaches (D-72) — the subject itself, on a
// language-first platform. Lives on the booking-page settings because it's
// public catalog data (students browse and filter by it, and it seeds the
// teacher's focus tags), not an account-level concern.
//
// A Combobox rather than a Select because the registry is 234 languages: the
// same call the country picker already makes. It type-filters and posts through
// a hidden input.
//
// Deliberately offers EVERY language, not just the caption-capable 12: you can
// teach Nahuatl even though nothing can transcribe it. The teaching-language
// picker beside it is the one that filters to caption-capable languages.
//
// Auto-saves on selection — a single discrete choice never needs an explicit
// Save button, so there isn't one (the save-UX pattern for pickers/toggles
// across settings). Inline status confirms the write.

export function TargetLanguageForm({
  initialTargetLanguage,
}: {
  initialTargetLanguage: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<string>(initialTargetLanguage ?? "");
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(
    saveTargetLanguageAction,
    undefined,
  );
  const options = useMemo(
    () => languageOptions(locale).map((l) => ({ value: l.code, label: l.label })),
    [locale],
  );

  function onValueChange(value: string) {
    setSelected(value);
    const data = new FormData();
    data.set("targetLanguage", value);
    startTransition(() => formAction(data));
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="targetLanguage">{t("web.settings.targetLanguage.label")}</Label>
        <Combobox
          id="targetLanguage"
          name="targetLanguage"
          className="max-w-xs"
          options={options}
          value={selected}
          onValueChange={onValueChange}
          placeholder={t("web.settings.targetLanguage.notSet")}
          searchPlaceholder={t("web.settings.targetLanguage.search")}
          emptyText={t("web.settings.targetLanguage.empty")}
        />
        <p className="text-xs text-muted-foreground">{t("web.settings.targetLanguage.hint")}</p>
      </div>
      <FormStatus
        state={state}
        pending={pending}
        savingMessage={t("web.settings.saving")}
        savedMessage={t("web.settings.targetLanguage.savedMessage")}
      />
    </div>
  );
}
