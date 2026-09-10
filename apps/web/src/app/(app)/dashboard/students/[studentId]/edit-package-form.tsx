"use client";

import { useActionState, useRef, useState, type FormEvent } from "react";
import { hasFieldErrors, validateManualPackageFields } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field-error";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { packageFieldMessage } from "./package-field-message";
import { editManualPackageAction, type ManualPackageState } from "@/app/actions/teacher-packages";
import { FormStatus } from "@/components/ui/form-status";
import { useLocale, useT } from "@/components/locale-provider";
import { usePricingCurrency } from "@/components/pricing-currency-context";

// Inline edit control for a package the teacher already recorded — the
// counterpart to AddPackageForm. An "Edit" button expands a prefilled form;
// the teacher fixes the total, classes left, class length, expiry and recorded
// price. Same "classes LEFT" model as adding. `committedBookings` is how many
// classes already count against this package; classes left can't be raised so
// high that the committed count would drop below it, so we cap it client-side
// (the server re-checks).
export function EditPackageForm({
  packageId,
  classesTotal: initialTotal,
  classesRemaining: initialRemaining,
  classDurationMin,
  expiresOn,
  pricePesos,
  committedBookings,
}: {
  packageId: string;
  classesTotal: number;
  classesRemaining: number;
  classDurationMin: number;
  expiresOn: string;
  pricePesos: string;
  committedBookings: number;
}) {
  const locale = useLocale();
  const en = locale === "en";
  const t = useT();
  const currency = usePricingCurrency();
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(String(initialTotal));
  const [remaining, setRemaining] = useState(String(initialRemaining));
  const [duration, setDuration] = useState(String(classDurationMin));
  const [price, setPrice] = useState(pricePesos);
  const { errors, setErrors, clearError } = useFieldErrors<"classesTotal" | "classesRemaining">();
  const totalRef = useRef<HTMLInputElement>(null);
  const remainingRef = useRef<HTMLInputElement>(null);
  const [state, formAction, pending] = useActionState<ManualPackageState, FormData>(
    editManualPackageAction,
    undefined,
  );

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("common.edit")}
      </Button>
    );
  }

  const totalNum = Number(total);
  // Classes left can run from 0 up to total, but never so high that fewer than
  // the already-committed classes would be marked used.
  const maxRemaining = totalNum - committedBookings;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const fieldErrors = validateManualPackageFields({
      classesTotal: total,
      classesRemaining: remaining,
      maxRemaining,
    });
    setErrors({
      classesTotal: packageFieldMessage(fieldErrors.classesTotal, en),
      classesRemaining: packageFieldMessage(fieldErrors.classesRemaining, en, maxRemaining),
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
      <input type="hidden" name="packageId" value={packageId} />

      <p className="text-sm font-medium">{t("web.dashboard.students.package.editPackage")}</p>
      {committedBookings > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("web.dashboard.students.package.committedHint", {
            count: String(committedBookings),
            max: String(Math.max(maxRemaining, 0)),
          })}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`edit-total-${packageId}`}>
            {t("web.dashboard.students.package.totalClasses")}{" "}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </Label>
          <Input
            id={`edit-total-${packageId}`}
            name="classesTotal"
            inputMode="numeric"
            ref={totalRef}
            aria-required="true"
            invalid={Boolean(errors.classesTotal)}
            aria-describedby={errors.classesTotal ? `edit-total-error-${packageId}` : undefined}
            value={total}
            onChange={(e) => {
              setTotal(e.target.value);
              clearError("classesTotal");
            }}
          />
          <FieldError id={`edit-total-error-${packageId}`} message={errors.classesTotal} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`edit-remaining-${packageId}`}>
            {t("web.dashboard.students.package.classesLeft")}{" "}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </Label>
          <Input
            id={`edit-remaining-${packageId}`}
            name="classesRemaining"
            inputMode="numeric"
            ref={remainingRef}
            aria-required="true"
            invalid={Boolean(errors.classesRemaining)}
            aria-describedby={
              errors.classesRemaining ? `edit-remaining-error-${packageId}` : undefined
            }
            value={remaining}
            onChange={(e) => {
              setRemaining(e.target.value);
              clearError("classesRemaining");
            }}
          />
          <FieldError id={`edit-remaining-error-${packageId}`} message={errors.classesRemaining} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`edit-duration-${packageId}`}>
            {t("web.dashboard.students.package.minutesPerClass")}
          </Label>
          <Input
            id={`edit-duration-${packageId}`}
            name="classDurationMin"
            inputMode="numeric"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`edit-expires-${packageId}`}>
            {t("web.dashboard.students.package.expiresOptional")}
          </Label>
          <Input
            id={`edit-expires-${packageId}`}
            name="expiresOn"
            type="date"
            defaultValue={expiresOn}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`edit-price-${packageId}`}>
          {t("web.dashboard.students.package.amountPaidOptionalNoAlready", { currency })}
        </Label>
        <Input
          id={`edit-price-${packageId}`}
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
            : t("web.dashboard.students.package.saveChanges")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </Button>
      </div>

      <FormStatus state={state} />
    </form>
  );
}
