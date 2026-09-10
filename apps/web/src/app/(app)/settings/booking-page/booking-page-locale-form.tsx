"use client";

import { useActionState, useState, startTransition } from "react";
import { LOCALES } from "@spiralclass/shared";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/components/locale-provider";
import { saveBookingPageLocaleAction, type ProfileState } from "@/app/actions/profile";

// The language her PUBLIC booking page renders in — every surface of the
// funnel, including the social card a shared link previews as.
//
// It sits beside the two teaching-language pickers because all three are
// "which language?" questions about her business, but it answers a different
// one: not what she teaches, not what she teaches in, and not what SHE reads,
// but what the people she sells to read. Those diverge — a teacher of Spanish
// selling to English speakers reads Spanish and needs an English page — which
// is exactly why this is her choice rather than something derived from a
// column we already have.
//
// Options come from the locale registry, so a language added there appears
// here with no change. Auto-saves on selection, like its two neighbours.
export function BookingPageLocaleForm({ initialLocale }: { initialLocale: string | null }) {
  const t = useT();
  const [selected, setSelected] = useState<string>(initialLocale ?? "");
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(
    saveBookingPageLocaleAction,
    undefined,
  );

  function onValueChange(value: string) {
    setSelected(value);
    const data = new FormData();
    data.set("bookingPageLocale", value);
    startTransition(() => formAction(data));
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="bookingPageLocale">{t("web.settings.bookingPageLocale.label")}</Label>
        <Select value={selected} onValueChange={onValueChange}>
          <SelectTrigger id="bookingPageLocale" className="max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCALES.map((l) => (
              // Each option in its OWN language: she is picking a language for
              // people who are not her, so an endonym is the one label that
              // reads correctly whatever her own UI is set to.
              <SelectItem key={l.tag} value={l.tag}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{t("web.settings.bookingPageLocale.hint")}</p>
      </div>
      <FormStatus
        state={state}
        pending={pending}
        savingMessage={t("web.settings.saving")}
        savedMessage={t("web.settings.bookingPageLocale.savedMessage")}
      />
    </div>
  );
}
