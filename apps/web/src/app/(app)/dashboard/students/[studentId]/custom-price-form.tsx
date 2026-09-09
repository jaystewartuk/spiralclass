"use client";

import { useActionState, useRef, useState, type FormEvent } from "react";
import { minorUnitsToMajor, formatMinorUnits, majorToMinorUnits } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "@/components/ui/field-error";
import { useFieldErrors } from "@/hooks/use-field-errors";
import { setStudentCustomPrice, type OverrideState } from "@/app/actions/overrides";
import { useT } from "@/components/locale-provider";
import { usePricingCurrency } from "@/components/pricing-currency-context";

// Grandfathering UI, PER PACKAGE. One row per sellable package; an empty
// row means "no agreed price for this one" and the catalog price applies.
//
// It used to be a single box. That box set one number for the whole pairing,
// and checkout charged it for WHICHEVER package the student picked — so a
// student held at the old 4-class price was shown the 20-class package at that
// price too, labelled "your agreed price". Teachers reprice one rung at a time;
// the form has to be able to say which rung.
//
// The teacher types major units (more natural than minor); minor units are
// serialized into one hidden JSON field so the action parses in one place.

export type PriceableTemplate = {
  id: string;
  name: string;
  priceMinorUnits: number;
};

export function CustomPriceForm({
  studentId,
  templates,
  current,
}: {
  studentId: string;
  templates: PriceableTemplate[];
  /** Agreed price per template id. A missing key means no agreed price. */
  current: Record<string, number>;
}) {
  const t = useT();
  const currency = usePricingCurrency();
  const [pesos, setPesos] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      templates.map((tpl) => {
        const minorUnits = current[tpl.id];
        return [
          tpl.id,
          minorUnits === undefined ? "" : String(minorUnitsToMajor(minorUnits, currency)),
        ];
      }),
    ),
  );
  const [reason, setReason] = useState("");
  const { errors, setErrors, clearError } = useFieldErrors<string>();
  const firstBadRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [state, formAction, pending] = useActionState<OverrideState, FormData>(
    setStudentCustomPrice,
    undefined,
  );

  // [{ templateId, minorUnits | null }] — null clears that package's row.
  const pricesJson = JSON.stringify(
    templates.map((tpl) => {
      const raw = pesos[tpl.id] ?? "";
      return {
        templateId: tpl.id,
        minorUnits: raw.trim() === "" ? null : majorToMinorUnits(Number(raw), currency),
      };
    }),
  );

  const agreedCount = templates.filter((tpl) => (pesos[tpl.id] ?? "").trim() !== "").length;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const next: Record<string, string> = {};
    for (const tpl of templates) {
      const raw = (pesos[tpl.id] ?? "").trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n >= 1_000_000) {
        next[tpl.id] = t("web.dashboard.students.price.invalidAmount");
      }
    }
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      next.reason = t("web.dashboard.students.price.required");
    } else if (trimmedReason.length < 3) {
      next.reason = t("web.dashboard.students.price.minChars");
    }
    setErrors(next);
    const badPrice = templates.find((tpl) => next[tpl.id]);
    if (badPrice || next.reason) {
      e.preventDefault();
      if (badPrice) firstBadRef.current?.focus();
      else reasonRef.current?.focus();
    }
  }

  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("web.dashboard.students.price.noPackages")}
      </p>
    );
  }

  const firstBadId = templates.find((tpl) => errors[tpl.id])?.id;

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="space-y-4">
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="pricesJson" value={pricesJson} />

      <p className="text-xs text-muted-foreground">
        {t("web.dashboard.students.price.perPackageHint")}
      </p>

      <div className="space-y-3">
        {templates.map((tpl) => (
          <div key={tpl.id} className="space-y-1">
            <Label htmlFor={`price-${tpl.id}`}>
              {tpl.name} — {t("web.dashboard.students.price.customPrice", { currency })}
            </Label>
            <Input
              id={`price-${tpl.id}`}
              ref={tpl.id === firstBadId ? firstBadRef : undefined}
              inputMode="decimal"
              placeholder={t("web.dashboard.students.price.pricePlaceholder")}
              value={pesos[tpl.id] ?? ""}
              invalid={Boolean(errors[tpl.id])}
              aria-describedby={errors[tpl.id] ? `price-${tpl.id}-error` : undefined}
              onChange={(e) => {
                setPesos((prev) => ({ ...prev, [tpl.id]: e.target.value }));
                clearError(tpl.id);
              }}
            />
            <FieldError id={`price-${tpl.id}-error`} message={errors[tpl.id]} />
            <p className="text-xs text-muted-foreground">
              {t("web.dashboard.students.price.catalogPrice", {
                price: formatMinorUnits(tpl.priceMinorUnits, currency),
              })}
            </p>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {t("web.dashboard.students.price.appliedHint")}{" "}
        {t("web.dashboard.students.price.agreedOnCount", {
          count: agreedCount,
          total: templates.length,
        })}
      </p>

      <div className="space-y-1">
        <Label htmlFor="customPriceReason">{t("web.dashboard.students.price.reasonLabel")}</Label>
        <Textarea
          id="customPriceReason"
          name="reason"
          ref={reasonRef}
          maxLength={500}
          value={reason}
          invalid={Boolean(errors.reason)}
          aria-describedby={errors.reason ? "customPriceReason-error" : undefined}
          placeholder={t("web.dashboard.students.price.reasonPlaceholder")}
          onChange={(e) => {
            setReason(e.target.value);
            clearError("reason");
          }}
        />
        <FieldError id="customPriceReason-error" message={errors.reason} />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? t("web.dashboard.students.package.saving") : t("common.save")}
        </Button>
      </div>

      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="text-sm text-success">
          {state.ok}
        </p>
      )}
    </form>
  );
}
