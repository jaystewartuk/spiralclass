"use client";

import { useActionState, useState, type FormEvent } from "react";
import { splitE164, teacherEditStudentContactSchema, zodFieldErrors } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { PhoneNumberField } from "@/components/phone-number-field";
import {
  updateStudentContactAsTeacherAction,
  type ContactFormState,
} from "@/app/actions/student-contact";
import { useLocale, useT } from "@/components/locale-provider";

// Roster contact fix: checkout typos in name/email/phone are common and
// were previously unfixable without support. Email is editable only while
// the student has never signed in — once their magic-link account exists,
// the row's email must move together with the auth identity, so the field
// locks (the student changes it from their own account instead).

export function ContactEditForm({
  studentId,
  initialName,
  initialEmail,
  initialPhone,
  emailLocked,
  defaultPhoneCountry,
}: {
  studentId: string;
  initialName: string;
  initialEmail: string | null;
  initialPhone: string | null;
  emailLocked: boolean;
  // The acting teacher's own country — a same-market default for a bare
  // national-format number, always overridable in the picker below.
  defaultPhoneCountry: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [state, formAction, pending] = useActionState<ContactFormState, FormData>(
    updateStudentContactAsTeacherAction,
    undefined,
  );
  const initialSplitPhone = initialPhone ? splitE164(initialPhone, defaultPhoneCountry) : null;
  const [phone, setPhone] = useState(initialSplitPhone?.localNumber ?? "");
  const [phoneCountry, setPhoneCountry] = useState(
    initialSplitPhone?.country ?? defaultPhoneCountry,
  );
  const { errors, setErrors, clearError } = useFieldErrors<"name">();

  // React 19 runs onSubmit before the form action; preventDefault cancels the
  // dispatch. Validate the one required field (name) inline via the shared
  // schema — messages come already localized, so nothing new hits the i18n
  // guard. Email/phone stay with the server action's form-level error.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const fd = new FormData(e.currentTarget);
    const parsed = teacherEditStudentContactSchema(locale).safeParse({
      studentId: fd.get("studentId"),
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
    <form action={formAction} onSubmit={handleSubmit} noValidate className="space-y-3">
      <input type="hidden" name="studentId" value={studentId} />

      <div className="space-y-1">
        <Label htmlFor="student-contact-name">{t("common.name")}</Label>
        <Input
          id="student-contact-name"
          name="name"
          required
          maxLength={80}
          defaultValue={initialName}
          invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "student-contact-name-error" : undefined}
          onChange={() => clearError("name")}
        />
        <FieldError id="student-contact-name-error" message={errors.name} />
      </div>

      <div className="space-y-1">
        <Label htmlFor="student-contact-email">{t("common.email")}</Label>
        <Input
          id="student-contact-email"
          name="email"
          type="email"
          defaultValue={initialEmail ?? ""}
          disabled={emailLocked}
        />
        <p className="text-muted-foreground text-xs">
          {emailLocked
            ? t("web.dashboard.students.contact.emailLockedHint")
            : t("web.dashboard.students.contact.emailHint")}
        </p>
      </div>

      <PhoneNumberField
        id="student-contact-phone"
        phoneName="phone"
        phone={phone}
        onPhoneChange={setPhone}
        countryName="phoneCountry"
        country={phoneCountry}
        onCountryChange={setPhoneCountry}
        label={t("web.dashboard.students.contact.phone")}
        placeholder={t("web.dashboard.students.phonePlaceholder")}
        hint={t("web.dashboard.students.contact.phoneHint")}
        countryAriaLabel={t("web.phoneCountrySelect.label")}
        countryPlaceholder={t("web.phoneCountrySelect.placeholder")}
        countrySearchPlaceholder={t("web.phoneCountrySelect.searchPlaceholder")}
        countryEmptyText={t("web.phoneCountrySelect.noResults")}
      />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t("web.dashboard.students.package.saving") : t("common.save")}
        </Button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
