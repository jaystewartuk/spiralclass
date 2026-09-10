"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  createIntegrationAction,
  updateIntegrationAction,
  type AdminEconomicsActionState,
} from "@/app/actions/admin-economics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import {
  INTEGRATION_CATEGORIES,
  DEFAULT_INTEGRATION_CATEGORY,
  type IntegrationCategory,
} from "@spiralclass/shared";
import { PricingModelEditor } from "./pricing-model-editor";
import type { IntegrationRow } from "./integrations-panel";

export type IntegrationFormValues = {
  id?: string;
  key: string;
  name: string;
  category: IntegrationCategory;
  currency: string;
  purpose: string;
  billingModel: string;
  billingUrl: string;
  docsUrl: string;
  notes: string;
  pricingModelJson: string;
};

export function blankIntegrationValues(): IntegrationFormValues {
  return {
    key: "",
    name: "",
    category: DEFAULT_INTEGRATION_CATEGORY,
    currency: "USD",
    purpose: "",
    billingModel: "",
    billingUrl: "",
    docsUrl: "",
    notes: "",
    pricingModelJson: JSON.stringify({ kind: "free" }, null, 2),
  };
}

// The row's raw `pricingModel` is whatever JSON is actually stored, even a
// value that no longer matches the schema — re-showing it (not a blanked
// default) is what lets an admin fix a malformed row via this same form.
export function integrationFormValuesFrom(row: IntegrationRow): IntegrationFormValues {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    category: (INTEGRATION_CATEGORIES as readonly string[]).includes(row.category)
      ? (row.category as IntegrationCategory)
      : DEFAULT_INTEGRATION_CATEGORY,
    currency: row.currency,
    purpose: row.purpose ?? "",
    billingModel: row.billingModel ?? "",
    billingUrl: row.billingUrl ?? "",
    docsUrl: row.docsUrl ?? "",
    notes: row.notes ?? "",
    pricingModelJson: JSON.stringify(row.pricingModel, null, 2),
  };
}

export function IntegrationForm({
  initial,
  onDone,
}: {
  initial: IntegrationFormValues;
  onDone?: () => void;
}) {
  const t = useT();
  const isEdit = Boolean(initial.id);
  const [state, action, pending] = useActionState<AdminEconomicsActionState, FormData>(
    isEdit ? updateIntegrationAction : createIntegrationAction,
    undefined,
  );
  const [pricingModelJson, setPricingModelJson] = useState(initial.pricingModelJson);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (state?.ok) onDoneRef.current?.();
  }, [state]);

  const suffix = initial.id ?? "new";

  return (
    <form action={action} className="space-y-3 rounded-md border bg-muted/30 p-4">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`key-${suffix}`}>{t("web.admin.economics.integrations.key")}</Label>
          <Input id={`key-${suffix}`} name="key" defaultValue={initial.key} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`name-${suffix}`}>{t("web.admin.economics.integrations.name")}</Label>
          <Input id={`name-${suffix}`} name="name" defaultValue={initial.name} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`category-${suffix}`}>
            {t("web.admin.economics.integrations.category")}
          </Label>
          <select
            id={`category-${suffix}`}
            name="category"
            required
            defaultValue={initial.category}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            {INTEGRATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`economics.category.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`currency-${suffix}`}>
            {t("web.admin.economics.integrations.currency")}
          </Label>
          <Input
            id={`currency-${suffix}`}
            name="currency"
            defaultValue={initial.currency}
            maxLength={3}
            className=""
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`billingModel-${suffix}`}>
            {t("web.admin.economics.integrations.billingModel")}
          </Label>
          <Input
            id={`billingModel-${suffix}`}
            name="billingModel"
            defaultValue={initial.billingModel}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`purpose-${suffix}`}>
            {t("web.admin.economics.integrations.purpose")}
          </Label>
          <Input id={`purpose-${suffix}`} name="purpose" defaultValue={initial.purpose} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`billingUrl-${suffix}`}>
            {t("web.admin.economics.integrations.billingUrl")}
          </Label>
          <Input
            id={`billingUrl-${suffix}`}
            name="billingUrl"
            type="url"
            defaultValue={initial.billingUrl}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`docsUrl-${suffix}`}>
            {t("web.admin.economics.integrations.docsUrl")}
          </Label>
          <Input
            id={`docsUrl-${suffix}`}
            name="docsUrl"
            type="url"
            defaultValue={initial.docsUrl}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`notes-${suffix}`}>{t("web.admin.economics.integrations.notes")}</Label>
          <Input id={`notes-${suffix}`} name="notes" defaultValue={initial.notes} />
        </div>
        <PricingModelEditor
          id={`pricingModelJson-${suffix}`}
          name="pricingModelJson"
          value={pricingModelJson}
          onChange={setPricingModelJson}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "…" : isEdit ? t("common.save") : t("web.admin.economics.integrations.add")}
        </Button>
        {isEdit && onDone ? (
          <Button type="button" variant="outline" onClick={onDone}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
