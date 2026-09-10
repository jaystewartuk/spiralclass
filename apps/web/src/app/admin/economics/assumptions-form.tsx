"use client";

import { useActionState, useState } from "react";
import {
  updateAssumptionsAction,
  type AdminEconomicsActionState,
} from "@/app/actions/admin-economics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/components/locale-provider";
import type { AllocationBasis, EconomicsAssumptionsValues } from "@/lib/economics/assumptions";

const ALLOCATION_BASES: AllocationBasis[] = ["active_teachers", "lessons", "even"];

export function AssumptionsForm({ initial }: { initial: EconomicsAssumptionsValues }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<AdminEconomicsActionState, FormData>(
    updateAssumptionsAction,
    undefined,
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">{t("web.admin.economics.fxAsOfLabel")}</CardTitle>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
          {t("web.admin.economics.fxEditToggle")}
        </Button>
      </CardHeader>
      {open ? (
        <CardContent>
          <form action={action} className="space-y-3">
            <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="fxUsdToGbp">{t("web.admin.economics.fxUsdLabel")}</Label>
                <Input
                  id="fxUsdToGbp"
                  name="fxUsdToGbp"
                  type="number"
                  step="0.0001"
                  min="0"
                  defaultValue={initial.fxUsdToGbp}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fxMxnToGbp">{t("web.admin.economics.fxMxnLabel")}</Label>
                <Input
                  id="fxMxnToGbp"
                  name="fxMxnToGbp"
                  type="number"
                  step="0.0001"
                  min="0"
                  defaultValue={initial.fxMxnToGbp}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fxEurToGbp">{t("web.admin.economics.fxEurLabel")}</Label>
                <Input
                  id="fxEurToGbp"
                  name="fxEurToGbp"
                  type="number"
                  step="0.0001"
                  min="0"
                  defaultValue={initial.fxEurToGbp}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fxAsOf">{t("web.admin.economics.fxAsOfLabel")}</Label>
                <Input
                  id="fxAsOf"
                  name="fxAsOf"
                  type="date"
                  defaultValue={initial.fxAsOf.toISOString().slice(0, 10)}
                  required
                />
              </div>
              <div className="space-y-1 lg:col-span-2 xl:col-span-4">
                <Label htmlFor="allocationBasis">
                  {t("web.admin.economics.allocationBasisLabel")}
                </Label>
                <select
                  id="allocationBasis"
                  name="allocationBasis"
                  required
                  defaultValue={initial.allocationBasis}
                  className="bg-background h-9 w-full rounded-md border px-2 text-sm lg:w-auto"
                >
                  {ALLOCATION_BASES.map((basis) => (
                    <option key={basis} value={basis}>
                      {t(`web.admin.economics.allocationBasis.${basis}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? "…" : t("common.save")}
            </Button>
            {state?.error && <p className="text-destructive text-sm">{state.error}</p>}
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}
