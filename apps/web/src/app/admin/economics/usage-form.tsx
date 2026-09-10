"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  upsertUsageInputAction,
  type AdminEconomicsActionState,
} from "@/app/actions/admin-economics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import { USAGE_METRICS, type UsageMetric } from "@spiralclass/shared";
import type { UsageEntry } from "./usage-panel";

export type UsageFormValues = {
  metric: UsageMetric;
  periodMonth: string;
  value: string;
  notes: string;
};

export function blankUsageValues(): UsageFormValues {
  return {
    metric: USAGE_METRICS[0],
    periodMonth: new Date().toISOString().slice(0, 7),
    value: "",
    notes: "",
  };
}

export function usageFormValuesFrom(entry: UsageEntry): UsageFormValues {
  return {
    metric: entry.metric as UsageMetric,
    periodMonth: entry.periodMonth,
    value: entry.value.toString(),
    notes: entry.notes ?? "",
  };
}

// Upsert-only (unique on metric + periodMonth) — re-entering the same
// metric/month is how an admin corrects a reading, so "edit" here just
// pre-fills this same form rather than a separate update action.
export function UsageForm({ initial, onDone }: { initial: UsageFormValues; onDone?: () => void }) {
  const t = useT();
  const [state, action, pending] = useActionState<AdminEconomicsActionState, FormData>(
    upsertUsageInputAction,
    undefined,
  );

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (state?.ok) onDoneRef.current?.();
  }, [state]);

  return (
    <form action={action} className="bg-muted/30 space-y-3 rounded-md border p-4">
      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="usage-metric">{t("web.admin.economics.usage.metric")}</Label>
          <select
            id="usage-metric"
            name="metric"
            required
            defaultValue={initial.metric}
            className="bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            {USAGE_METRICS.map((m) => (
              <option key={m} value={m}>
                {t(`economics.metric.${m}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="usage-periodMonth">{t("web.admin.economics.usage.period")}</Label>
          <Input
            id="usage-periodMonth"
            name="periodMonth"
            type="month"
            defaultValue={initial.periodMonth}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="usage-value">{t("web.admin.economics.usage.value")}</Label>
          <Input
            id="usage-value"
            name="value"
            type="number"
            step="0.01"
            min="0"
            defaultValue={initial.value}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="usage-notes">{t("web.admin.economics.usage.notes")}</Label>
          <Input id="usage-notes" name="notes" defaultValue={initial.notes} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "…" : t("web.admin.economics.usage.add")}
        </Button>
        {onDone ? (
          <Button type="button" variant="outline" onClick={onDone}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
      {state?.error && <p className="text-destructive text-sm">{state.error}</p>}
    </form>
  );
}
