"use client";

import { useActionState, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableShell,
} from "@/components/ui/table";
import { useT } from "@/components/locale-provider";
import { isUsageMetric } from "@spiralclass/shared";
import {
  deleteUsageInputAction,
  type AdminEconomicsActionState,
} from "@/app/actions/admin-economics";
import { UsageForm, blankUsageValues, usageFormValuesFrom } from "./usage-form";

export type UsageEntry = {
  id: string;
  metric: string;
  periodMonth: string; // "YYYY-MM"
  value: number;
  source: string;
  notes: string | null;
};

function DeleteUsageButton({ id }: { id: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<AdminEconomicsActionState, FormData>(
    deleteUsageInputAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) setOpen(false);
  }, [state?.ok]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button type="button" variant="outline" size="sm">
          {t("common.delete")}
        </Button>
      }
      title={t("web.admin.economics.usage.deleteConfirm")}
      footer={() => (
        <Button
          type="submit"
          form={`delete-usage-${id}`}
          variant="destructive"
          size="sm"
          disabled={pending}
        >
          {t("common.delete")}
        </Button>
      )}
    >
      <form id={`delete-usage-${id}`} action={action}>
        <input type="hidden" name="id" value={id} />
        {state?.error && <p className="text-destructive text-sm">{state.error}</p>}
      </form>
    </ConfirmDialog>
  );
}

export function UsagePanel({ entries }: { entries: UsageEntry[] }) {
  const t = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const editingEntry = entries.find((e) => e.id === editingId) ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">{t("web.admin.economics.usage.title")}</CardTitle>
        {!adding ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setAdding(true);
              setEditingId(null);
            }}
          >
            {t("web.admin.economics.usage.add")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {adding ? <UsageForm initial={blankUsageValues()} onDone={() => setAdding(false)} /> : null}
        {editingEntry ? (
          <UsageForm
            key={editingEntry.id}
            initial={usageFormValuesFrom(editingEntry)}
            onDone={() => setEditingId(null)}
          />
        ) : null}

        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("web.admin.economics.usage.noEntries")}
          </p>
        ) : (
          <TableShell>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("web.admin.economics.usage.period")}</TableHead>
                  <TableHead>{t("web.admin.economics.usage.metric")}</TableHead>
                  <TableHead className="text-right">
                    {t("web.admin.economics.usage.value")}
                  </TableHead>
                  <TableHead>{t("web.admin.economics.usage.source")}</TableHead>
                  <TableHead>{t("web.admin.economics.usage.notes")}</TableHead>
                  <TableHead className="text-right">{t("web.admin.staff.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap">{entry.periodMonth}</TableCell>
                    <TableCell>
                      {t(
                        `economics.metric.${isUsageMetric(entry.metric) ? entry.metric : "lessons"}`,
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {entry.value.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={entry.source === "auto" ? "info" : "outline"}>
                        {t(
                          `web.admin.economics.usage.source.${entry.source === "auto" ? "auto" : "manual"}`,
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
                      {entry.notes ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditingId(entry.id);
                            setAdding(false);
                          }}
                        >
                          {t("common.edit")}
                        </Button>
                        <DeleteUsageButton id={entry.id} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}
