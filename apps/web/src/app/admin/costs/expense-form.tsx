"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  createExpenseAction,
  updateExpenseAction,
  type AdminCostsActionState,
} from "@/app/actions/admin-costs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import {
  KNOWN_EXPENSE_VENDORS,
  EXPENSE_CATEGORIES,
  DEFAULT_EXPENSE_CATEGORY,
  minorUnitsToMajor,
  type ExpenseVendor,
  type ExpenseCategory,
} from "@spiralclass/shared";

const CURRENCIES = ["MXN", "USD", "GBP"] as const;

export type ExpenseFormValues = {
  id?: string;
  vendor: ExpenseVendor;
  vendorLabel: string;
  category: ExpenseCategory;
  amount: string;
  currency: (typeof CURRENCIES)[number];
  periodMonth: string;
  notes: string;
};

export function blankExpenseValues(): ExpenseFormValues {
  return {
    vendor: "vercel",
    vendorLabel: "",
    category: DEFAULT_EXPENSE_CATEGORY.vercel,
    amount: "",
    currency: "MXN",
    periodMonth: new Date().toISOString().slice(0, 7),
    notes: "",
  };
}

export function expenseFormValuesFrom(entry: {
  id: string;
  vendor: string;
  vendorLabel: string | null;
  category: string;
  amountMinorUnits: number;
  currency: string;
  periodMonth: string;
  notes: string | null;
}): ExpenseFormValues {
  return {
    id: entry.id,
    vendor: entry.vendor as ExpenseVendor,
    vendorLabel: entry.vendorLabel ?? "",
    category: entry.category as ExpenseCategory,
    amount: minorUnitsToMajor(entry.amountMinorUnits, entry.currency).toString(),
    currency: (entry.currency as (typeof CURRENCIES)[number]) ?? "MXN",
    periodMonth: entry.periodMonth,
    notes: entry.notes ?? "",
  };
}

export function ExpenseForm({
  initial,
  onDone,
}: {
  initial: ExpenseFormValues;
  onDone?: () => void;
}) {
  const t = useT();
  const isEdit = Boolean(initial.id);
  const [state, action, pending] = useActionState<AdminCostsActionState, FormData>(
    isEdit ? updateExpenseAction : createExpenseAction,
    undefined,
  );
  const [vendor, setVendor] = useState<ExpenseVendor>(initial.vendor);

  // `onDone` is a fresh closure every parent render — hold it in a ref so the
  // effect's dependency array can stay exhaustive (just `state`) without
  // re-firing on every parent re-render.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (state?.ok) onDoneRef.current?.();
  }, [state]);

  return (
    <form action={action} className="bg-muted/30 space-y-3 rounded-md border p-4">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`vendor-${initial.id ?? "new"}`}>{t("web.admin.costs.vendor")}</Label>
          <select
            id={`vendor-${initial.id ?? "new"}`}
            name="vendor"
            required
            value={vendor}
            onChange={(e) => setVendor(e.target.value as ExpenseVendor)}
            className="bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            {KNOWN_EXPENSE_VENDORS.map((v) => (
              <option key={v} value={v}>
                {t(`expense.vendor.${v}`)}
              </option>
            ))}
          </select>
        </div>
        {vendor === "other" ? (
          <div className="space-y-1">
            <Label htmlFor={`vendorLabel-${initial.id ?? "new"}`}>
              {t("web.admin.costs.vendorLabel")}
            </Label>
            <Input
              id={`vendorLabel-${initial.id ?? "new"}`}
              name="vendorLabel"
              defaultValue={initial.vendorLabel}
              required
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={`category-${initial.id ?? "new"}`}>{t("web.admin.costs.category")}</Label>
          <select
            id={`category-${initial.id ?? "new"}`}
            name="category"
            required
            defaultValue={initial.category}
            className="bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`expense.category.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`amount-${initial.id ?? "new"}`}>{t("web.admin.costs.amount")}</Label>
          <Input
            id={`amount-${initial.id ?? "new"}`}
            name="amount"
            type="number"
            step="0.01"
            min="0"
            defaultValue={initial.amount}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`currency-${initial.id ?? "new"}`}>{t("web.admin.costs.currency")}</Label>
          <select
            id={`currency-${initial.id ?? "new"}`}
            name="currency"
            required
            defaultValue={initial.currency}
            className="bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`periodMonth-${initial.id ?? "new"}`}>
            {t("web.admin.costs.period")}
          </Label>
          <Input
            id={`periodMonth-${initial.id ?? "new"}`}
            name="periodMonth"
            type="month"
            defaultValue={initial.periodMonth}
            required
          />
        </div>
        <div className="space-y-1 lg:col-span-2 xl:col-span-3">
          <Label htmlFor={`notes-${initial.id ?? "new"}`}>{t("web.admin.costs.notes")}</Label>
          <Input id={`notes-${initial.id ?? "new"}`} name="notes" defaultValue={initial.notes} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "…" : isEdit ? t("common.save") : t("web.admin.costs.add")}
        </Button>
        {isEdit && onDone ? (
          <Button type="button" variant="outline" onClick={onDone}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
      {state?.error && <p className="text-destructive text-sm">{state.error}</p>}
    </form>
  );
}
