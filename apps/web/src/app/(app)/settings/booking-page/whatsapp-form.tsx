"use client";

import { useActionState, useState } from "react";
import { splitE164 } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { PhoneNumberField } from "@/components/phone-number-field";
import { useT } from "@/components/locale-provider";
import { saveBookingPageWhatsappAction, type ProfileState } from "@/app/actions/profile";

// Editor for the PUBLIC-facing WhatsApp "Chat on WhatsApp" button on
// /b/<slug>. Deliberately its own small form, not reused from MyDetailsForm
// (settings/account) — that one edits the private account phone, this one
// edits a separate opt-in field (publicWhatsappE164) with its own consent
// scope (see schema.prisma's Teacher.publicWhatsappE164). Clearing the field
// hides the button.
export function WhatsAppForm({
  initialWhatsapp,
  initialCountry,
}: {
  initialWhatsapp: string | null;
  initialCountry: string;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(
    saveBookingPageWhatsappAction,
    undefined,
  );
  const initialSplit = initialWhatsapp ? splitE164(initialWhatsapp, initialCountry) : null;
  const [country, setCountry] = useState(initialSplit?.country ?? initialCountry ?? "MX");
  const [phone, setPhone] = useState(initialSplit?.localNumber ?? "");

  return (
    <form action={formAction} className="space-y-3">
      <PhoneNumberField
        id="booking-page-whatsapp"
        phoneName="whatsapp"
        phone={phone}
        onPhoneChange={setPhone}
        countryName="whatsappCountry"
        country={country}
        onCountryChange={setCountry}
        label={t("web.settings.bookingPage.whatsappLabel")}
        placeholder="55 1234 5678"
        hint={t("web.settings.bookingPage.whatsappHint")}
        countryAriaLabel={t("web.phoneCountrySelect.label")}
        countryPlaceholder={t("web.phoneCountrySelect.placeholder")}
        countrySearchPlaceholder={t("web.phoneCountrySelect.searchPlaceholder")}
        countryEmptyText={t("web.phoneCountrySelect.noResults")}
      />
      <FormStatus state={state} savedMessage={t("bookingPage.saved")} />
      <Button type="submit" disabled={pending}>
        {pending ? t("web.settings.bookingPage.saving") : t("common.save")}
      </Button>
    </form>
  );
}
