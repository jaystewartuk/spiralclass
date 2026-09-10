"use client";

import { useActionState, useRef, useState, type FormEvent } from "react";
import { hasFieldErrors, validateManualPackageFields } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { packageFieldMessage } from "./package-field-message";
import { createManualPackageAction, type ManualPackageState } from "@/app/actions/teacher-packages";
import { FormStatus } from "@/components/ui/form-status";
import { useLocale, useT } from "@/components/locale-provider";
import { usePricingCurrency } from "@/components/pricing-currency-context";

export type PackageTemplateOption = {
  id: string;
  name: string;
  classCount: number;
  classDurationMin: number;
  pricePesos: string;
};

// Record an off-platform package — the mid-package onboarding control. The
// teacher enters how many classes the student has LEFT; the server stores the
// rest as already-used so the booking ledger picks up exactly where her
// notebook left off. Picking a template just prefills the numbers; every field
// stays editable.
export function AddPackageForm({
  studentId,
  templates,
}: {
  studentId: string;
  templates: PackageTemplateOption[];
}) {
  const locale = useLocale();
  const en = locale === "en";
  const t = useT();
  const currency = usePricingCurrency();
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState("");
  const [remaining, setRemaining] = useState("");
  const [duration, setDuration] = useState("50");
  const [price, setPrice] = useState("");
  const { errors, setErrors, clearError } = useFieldErrors<"classesTotal" | "classesRemaining">();
  const totalRef = useRef<HTMLInputElement>(null);
  const remainingRef = useRef<HTMLInputElement>(null);
  const [state, formAction, pending] = useActionState<ManualPackageState, FormData>(
    createManualPackageAction,
    undefined,
  );

  function applyTemplate(id: string) {
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    setTotal(String(tpl.classCount));
    // A fresh full package starts with every class remaining; the teacher
    // adjusts this down for a mid-package student.
    setRemaining(String(tpl.classCount));
    setDuration(String(tpl.classDurationMin));
    setPrice(tpl.pricePesos);
    setErrors({});
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("web.dashboard.students.package.add")}
      </Button>
    );
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const fieldErrors = validateManualPackageFields({
      classesTotal: total,
      classesRemaining: remaining,
    });
    setErrors({
      classesTotal: packageFieldMessage(fieldErrors.classesTotal, en),
      classesRemaining: packageFieldMessage(fieldErrors.classesRemaining, en),
    });
    if (hasFieldErrors(fieldErrors)) {
      e.preventDefault();
      if (fieldErrors.classesTotal) totalRef.current?.focus();
      else if (fieldErrors.classesRemaining) remainingRef.current?.focus();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={handleSubmit}
      noValidate
      className="bg-muted/30 space-y-3 rounded-md border p-3"
    >
      <input type="hidden" name="studentId" value={studentId} />

      <p className="text-sm font-medium">{t("web.dashboard.students.package.recordExisting")}</p>
      <p className="text-muted-foreground text-xs">
        {t("web.dashboard.students.package.recordExistingHint")}
      </p>

      {templates.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor="pkg-template">{t("web.dashboard.students.package.basedOn")}</Label>
          <select
            id="pkg-template"
            name="templateId"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            defaultValue=""
            onChange={(e) => applyTemplate(e.target.value)}
          >
            <option value="">{t("web.dashboard.students.package.custom")}</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name} · {tpl.classCount} × {tpl.classDurationMin} min
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="pkg-total">
            {t("web.dashboard.students.package.totalClasses")}{" "}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </Label>
          <Input
            id="pkg-total"
            name="classesTotal"
            inputMode="numeric"
            ref={totalRef}
            aria-required="true"
            invalid={Boolean(errors.classesTotal)}
            aria-describedby={errors.classesTotal ? "pkg-total-error" : undefined}
            value={total}
            onChange={(e) => {
              setTotal(e.target.value);
              clearError("classesTotal");
            }}
          />
          <FieldError id="pkg-total-error" message={errors.classesTotal} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pkg-remaining">
            {t("web.dashboard.students.package.classesLeft")}{" "}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </Label>
          <Input
            id="pkg-remaining"
            name="classesRemaining"
            inputMode="numeric"
            ref={remainingRef}
            aria-required="true"
            invalid={Boolean(errors.classesRemaining)}
            aria-describedby={errors.classesRemaining ? "pkg-remaining-error" : undefined}
            value={remaining}
            onChange={(e) => {
              setRemaining(e.target.value);
              clearError("classesRemaining");
            }}
          />
          <FieldError id="pkg-remaining-error" message={errors.classesRemaining} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="pkg-duration">
            {t("web.dashboard.students.package.minutesPerClass")}
          </Label>
          <Input
            id="pkg-duration"
            name="classDurationMin"
            inputMode="numeric"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pkg-expires">{t("web.dashboard.students.package.expiresOptional")}</Label>
          <Input id="pkg-expires" name="expiresOn" type="date" />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="pkg-price">
          {t("web.dashboard.students.package.amountPaidOptional", { currency })}
        </Label>
        <Input
          id="pkg-price"
          name="amountPaidPesos"
          inputMode="decimal"
          placeholder={t("web.dashboard.students.package.forYourRecords")}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending
            ? t("web.dashboard.students.package.saving")
            : t("web.dashboard.students.package.savePackage")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </Button>
      </div>

      <FormStatus state={state} />
    </form>
  );
}
