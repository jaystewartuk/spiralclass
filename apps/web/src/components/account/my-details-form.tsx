"use client";

import { useActionState, useEffect, useMemo, useState, type FormEvent } from "react";
import { splitE164, teacherContactSchema, zodFieldErrors } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhoneNumberField } from "@/components/phone-number-field";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { useLocale, useT } from "@/components/locale-provider";

// Shared "My details" card for both the student and teacher account pages:
// name, phone number and time zone. Email lives in its own card (the
// verified email-change flow) — it's the sign-in identity, so it never edits
// inline here.
//
// The phone's country is always freely editable via its own chip, for both
// roles — deliberately independent of a teacher's payout country (her Stripe
// Connect country, set via the separate Country card/action on her account
// page): a phone number can carry a different country's calling code than
// where she's based for payouts, so the two must never be locked together.

export type DetailsFormState = { ok?: string; error?: string } | undefined;

type Props = {
  action: (state: DetailsFormState, formData: FormData) => Promise<DetailsFormState>;
  initialName: string;
  initialPhone: string | null;
  initialTimezone: string | null;
  timezoneOptions: string[];
  // Seeds the phone-country chip (e.g. a teacher's own country, as a
  // same-market guess) — always overridable, never synced back to any other
  // field. Defaults to "MX" when omitted (the student caller has no
  // first-class country of their own to seed from).
  initialPhoneCountry?: string;
};

export function MyDetailsForm({
  action,
  initialName,
  initialPhone,
  initialTimezone,
  timezoneOptions,
  initialPhoneCountry,
}: Props) {
  const t = useT();
  const locale = useLocale();
  const [state, formAction, pending] = useActionState<DetailsFormState, FormData>(
    action,
    undefined,
  );
  const { errors, setErrors, clearError } = useFieldErrors<"name">();
  const initialSplitPhone = initialPhone ? splitE164(initialPhone, initialPhoneCountry) : null;
  const [selectedPhoneCountry, setSelectedPhoneCountry] = useState(
    initialSplitPhone?.country ?? initialPhoneCountry ?? "MX",
  );

  const [detected, setDetected] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDetected(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      setDetected(null);
    }
  }, []);

  const zones = useMemo(() => {
    const set = new Set(timezoneOptions);
    if (detected) set.add(detected);
    if (initialTimezone) set.add(initialTimezone);
    return Array.from(set).sort();
  }, [timezoneOptions, detected, initialTimezone]);

  const [timezone, setTimezone] = useState<string>(initialTimezone ?? "");
  const [phone, setPhone] = useState<string>(initialSplitPhone?.localNumber ?? "");

  // Inline per-field validation (canonical form pattern): keep the submit button
  // enabled and validate on submit, pointing at the offending field. React 19
  // runs onSubmit before the form action and honours preventDefault, so an
  // invalid form never dispatches. Only `name` is a hard client-side rule (the
  // shared contact schema's required check); phone/timezone stay server-side.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const result = teacherContactSchema(locale).safeParse({
      name: new FormData(e.currentTarget).get("name"),
    });
    if (!result.success) {
      const fieldErrors = zodFieldErrors(result.error);
      if (fieldErrors.name) {
        e.preventDefault();
        setErrors({ name: fieldErrors.name });
      }
    }
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="contact-name">{t("common.name")}</Label>
        <Input
          id="contact-name"
          name="name"
          autoComplete="name"
          required
          maxLength={80}
          defaultValue={initialName}
          invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "contact-name-error" : undefined}
          onChange={() => clearError("name")}
        />
        <FieldError id="contact-name-error" message={errors.name} />
      </div>

      <PhoneNumberField
        id="contact-phone"
        phoneName="phone"
        phone={phone}
        onPhoneChange={setPhone}
        countryName="phoneCountry"
        country={selectedPhoneCountry}
        onCountryChange={setSelectedPhoneCountry}
        label={t("web.myDetailsForm.phone")}
        placeholder={t("web.myDetailsForm.phoneWithCountryPlaceholder")}
        hint={t("web.myDetailsForm.phoneWithCountryHint")}
        countryAriaLabel={t("web.phoneCountrySelect.label")}
        countryPlaceholder={t("web.phoneCountrySelect.placeholder")}
        countrySearchPlaceholder={t("web.phoneCountrySelect.searchPlaceholder")}
        countryEmptyText={t("web.phoneCountrySelect.noResults")}
      />

      <div className="space-y-1">
        <Label htmlFor="contact-timezone">{t("web.myDetailsForm.timezone")}</Label>
        <Select value={timezone || undefined} onValueChange={setTimezone}>
          <SelectTrigger id="contact-timezone">
            <SelectValue placeholder={t("web.myDetailsForm.timezonePlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {zones.map((z) => (
              <SelectItem key={z} value={z}>
                {z}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input type="hidden" name="timezone" value={timezone} />
        <p className="text-muted-foreground text-xs">{t("web.myDetailsForm.timezoneHint")}</p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t("web.myDetailsForm.saving") : t("common.save")}
        </Button>
        {/* The routine "Details saved." confirmation fades like every other
            form; the D-53 stale-availability-zone warning (a longer message
            appended after it by updateMyTeacherContactAction) carries
            information worth keeping visible, matching FormStatus's own
            documented convention (see blocked-date-form.tsx). */}
        <FormStatus
          state={state}
          fade={state?.ok === "Details saved." || state?.ok === "Datos guardados."}
        />
      </div>
    </form>
  );
}
