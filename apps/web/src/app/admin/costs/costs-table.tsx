"use client";

import { useActionState, useState } from "react";
import { deleteExpenseAction, type AdminCostsActionState } from "@/app/actions/admin-costs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { formatMinorUnits } from "@/lib/money";
import type { ExpenseCategory, ExpenseVendor } from "@spiralclass/shared";
import { ExpenseForm, blankExpenseValues, expenseFormValuesFrom } from "./expense-form";

export type ExpenseRow = {
  id: string;
  vendor: ExpenseVendor;
  vendorLabel: string | null;
  category: ExpenseCategory;
  amountMinorUnits: number;
  currency: string;
  periodMonth: string; // "YYYY-MM"
  notes: string | null;
};

function DeleteExpenseButton({ id }: { id: string }) {
  const t = useT();
  const [, action, pending] = useActionState<AdminCostsActionState, FormData>(
    deleteExpenseAction,
    undefined,
  );
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={(e) => {
          if (!window.confirm(t("web.admin.costs.deleteConfirm"))) e.preventDefault();
        }}
      >
        {t("common.delete")}
      </Button>
    </form>
  );
}

export function CostsTable({ entries }: { entries: ExpenseRow[] }) {
  const t = useT();
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <ExpenseForm initial={blankExpenseValues()} />

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("web.admin.costs.noEntries")}</p>
      ) : (
        <TableShell>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("web.admin.costs.period")}</TableHead>
                <TableHead>{t("web.admin.costs.vendor")}</TableHead>
                <TableHead>{t("web.admin.costs.category")}</TableHead>
                <TableHead className="text-right">{t("web.admin.costs.amount")}</TableHead>
                <TableHead>{t("web.admin.costs.notes")}</TableHead>
                <TableHead className="text-right">{t("web.admin.staff.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) =>
                editingId === entry.id ? (
                  <TableRow key={entry.id}>
                    <TableCell colSpan={6}>
                      <ExpenseForm
                        initial={expenseFormValuesFrom(entry)}
                        onDone={() => setEditingId(null)}
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap">{entry.periodMonth}</TableCell>
                    <TableCell>
                      {entry.vendor === "other" && entry.vendorLabel
                        ? entry.vendorLabel
                        : t(`expense.vendor.${entry.vendor}`)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="info">{t(`expense.category.${entry.category}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinorUnits(entry.amountMinorUnits, entry.currency)}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                      {entry.notes ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setEditingId(entry.id)}>
                          {t("common.edit")}
                        </Button>
                        <DeleteExpenseButton id={entry.id} />
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        </TableShell>
      )}
    </div>
  );
}
