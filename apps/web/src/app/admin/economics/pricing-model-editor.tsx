"use client";

import { useMemo } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import { pricingModelSchema } from "@spiralclass/shared";

// D-86 MVP pricing-model editor: a JSON textarea with live Zod validation
// against the shared discriminated-union schema (economics-pricing.ts). A
// structured, kind-aware editor is a fast-follow (S6+) — see the doc's
// "Frontend" section.
export function PricingModelEditor({
  id,
  name,
  value,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();

  const error = useMemo(() => {
    if (!value.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return t("web.admin.economics.integrations.pricingModelInvalid");
    }
    const result = pricingModelSchema.safeParse(parsed);
    return result.success
      ? null
      : (result.error.issues[0]?.message ??
          t("web.admin.economics.integrations.pricingModelInvalid"));
  }, [value, t]);

  return (
    <div className="space-y-1 lg:col-span-2 xl:col-span-3">
      <Label htmlFor={id}>{t("web.admin.economics.integrations.pricingModel")}</Label>
      <Textarea
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        invalid={!!error}
        className="font-mono text-xs"
        required
      />
      <p className="text-xs text-muted-foreground">
        {t("web.admin.economics.integrations.pricingModelHint")}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
