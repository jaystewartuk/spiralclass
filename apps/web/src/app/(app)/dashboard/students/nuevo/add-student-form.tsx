"use client";

import { useState, type FormEvent } from "react";
import { useActionState } from "react";
import { teacherCreateStudentSchema, zodFieldErrors } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { PhoneNumberField } from "@/components/phone-number-field";
import { createStudentAction, type RosterActionState } from "@/app/actions/teacher-students";
import { useLocale, useT } from "@/components/locale-provider";

// Manually add a student to the roster (silent onboarding). The new student is
// staged on hold — no notifications go out — so the teacher can set up packages
// and book classes before going live. Email and phone are optional; she can
// fill them in later from the student's contact card.
export function AddStudentForm({ defaultPhoneCountry }: { defaultPhoneCountry: string }) {
  const t = useT();
  const locale = useLocale();
  const [state, formAction, pending] = useActionState<RosterActionState, FormData>(
    createStudentAction,
    undefined,
  );
  const [phone, setPhone] = useState("");
  const [phoneCountry, setPhoneCountry] = useState(defaultPhoneCountry);
  const { errors, setErrors, clearError } = useFieldErrors<"name">();

  // React 19 runs onSubmit before the form action; preventDefault cancels the
  // dispatch. Validate the one required field (name) inline via the shared
  // schema — messages arrive already localized, so nothing new hits the i18n
  // guard. Optional email/phone stay with the server action's form-level error.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const fd = new FormData(e.currentTarget);
    const parsed = teacherCreateStudentSchema(locale).safeParse({
      name: fd.get("name"),
      email: fd.get("email") ?? undefined,
      phone: fd.get("phone"),
      phoneCountry: fd.get("phoneCountry") ?? undefined,
    });
    if (!parsed.success) {
      const fieldErrors = zodFieldErrors(parsed.error);
      if (fieldErrors.name) {
        e.preventDefault();
        setErrors({ name: fieldErrors.name });
      }
    }
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="new-student-name">{t("common.name")}</Label>
        <Input
          id="new-student-name"
          name="name"
          required
          maxLength={80}
          autoFocus
          invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "new-student-name-error" : undefined}
          onChange={() => clearError("name")}
        />
        <FieldError id="new-student-name-error" message={errors.name} />
      </div>

      <div className="space-y-1">
        <Label htmlFor="new-student-email">{t("web.dashboard.students.emailOptional")}</Label>
        <Input id="new-student-email" name="email" type="email" />
        <p className="text-xs text-muted-foreground">{t("web.dashboard.students.new.emailHint")}</p>
      </div>

      <PhoneNumberField
        id="new-student-phone"
        phoneName="phone"
        phone={phone}
        onPhoneChange={setPhone}
        countryName="phoneCountry"
        country={phoneCountry}
        onCountryChange={setPhoneCountry}
        label={t("web.dashboard.students.phoneOptional")}
        placeholder={t("web.dashboard.students.phonePlaceholder")}
        countryAriaLabel={t("web.phoneCountrySelect.label")}
        countryPlaceholder={t("web.phoneCountrySelect.placeholder")}
        countrySearchPlaceholder={t("web.phoneCountrySelect.searchPlaceholder")}
        countryEmptyText={t("web.phoneCountrySelect.noResults")}
      />

      <Button type="submit" disabled={pending}>
        {pending
          ? t("web.dashboard.students.new.adding")
          : t("web.dashboard.students.new.addStudent")}
      </Button>

      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
