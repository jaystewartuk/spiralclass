"use client";

import { useActionState, useState } from "react";
import { Lock } from "lucide-react";
import { countryLabel } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Combobox } from "@/components/ui/combobox";
import { useLocale, useT } from "@/components/locale-provider";
import {
  updateMyTeacherCountryAction,
  type TeacherCountryFormState,
} from "@/app/actions/teacher-account";

// Teacher country editor. Editable via the searchable Combobox only while no
// Stripe account is linked; once linked the country is frozen on Stripe's side
// (immutable), so we show it read-only with a note pointing at disconnect —
// mirroring the server-side guard in updateMyTeacherCountryAction.
//
// The control is named by `aria-label` rather than a visible <Label>: the
// settings row this renders inside already carries "Country" as its heading,
// directly above, and a second visible copy of the same word was the label
// saying nothing the heading had not.
export function CountryForm({
  initialCountry,
  countries,
  locked,
}: {
  initialCountry: string;
  countries: Array<{ code: string; label: string }>;
  locked: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [country, setCountry] = useState<string>(initialCountry);
  const [state, formAction, pending] = useActionState<TeacherCountryFormState, FormData>(
    updateMyTeacherCountryAction,
    undefined,
  );

  if (locked) {
    return (
      <div className="space-y-2">
        <p className="font-medium">{countryLabel(initialCountry, locale)}</p>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("web.settings.country.lockedNote")}</span>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <div className="space-y-2">
        <div className="max-w-xs">
          <Combobox
            id="country"
            name="country"
            value={country}
            onValueChange={setCountry}
            options={countries.map((c) => ({ value: c.code, label: c.label }))}
            placeholder={t("web.settings.country.selectPlaceholder")}
            searchPlaceholder={t("web.settings.country.searchPlaceholder")}
            emptyText={t("web.settings.country.noResults")}
            aria-label={t("web.settings.country.label")}
          />
        </div>
        <p className="text-sm text-muted-foreground">{t("web.settings.country.hint")}</p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t("web.settings.saving") : t("common.save")}
        </Button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
