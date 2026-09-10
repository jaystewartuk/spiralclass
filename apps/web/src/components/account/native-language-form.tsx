"use client";

import { useActionState, useState } from "react";
import { languageOptions } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
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
import { saveNativeLanguageAction, type ContactFormState } from "@/app/actions/student-contact";

// Live-caption default (D-27): the student's own language — mirrors
// app/(app)/settings/account/teaching-language-form.tsx on the teacher side.
export function NativeLanguageForm({ initialLanguage }: { initialLanguage: string }) {
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<string>(initialLanguage);
  const [state, formAction, pending] = useActionState<ContactFormState, FormData>(
    saveNativeLanguageAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="nativeLanguage" value={selected} />
      <div className="space-y-2">
        <Label htmlFor="nativeLanguage">{t("web.myClasses.account.nativeLanguage.label")}</Label>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger id="nativeLanguage" className="max-w-xs">
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
        <p className="text-muted-foreground text-xs">
          {t("web.myClasses.account.nativeLanguage.hint")}
        </p>
      </div>
      <FormStatus
        state={state}
        savedMessage={t("web.myClasses.account.nativeLanguage.savedMessage")}
      />
      <Button type="submit" disabled={pending}>
        {pending ? t("web.settings.saving") : t("common.save")}
      </Button>
    </form>
  );
}
