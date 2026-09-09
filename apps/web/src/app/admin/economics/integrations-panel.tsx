"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import {
  IntegrationForm,
  blankIntegrationValues,
  integrationFormValuesFrom,
} from "./integration-form";
import { IntegrationsTable } from "./integrations-table";

// The raw Integration row shape the S4 admin CRUD surface reads/writes —
// deliberately NOT lib/economics/registry.ts's parsed IntegrationRegistryEntry
// (see the comment in page.tsx): this table needs every column, including a
// pricingModel value that might not parse, so an admin can fix it.
export type IntegrationRow = {
  id: string;
  key: string;
  name: string;
  category: string;
  currency: string;
  purpose: string | null;
  pricingModel: unknown;
  billingModel: string | null;
  notes: string | null;
  billingUrl: string | null;
  docsUrl: string | null;
  active: boolean;
  sortOrder: number;
};

export function IntegrationsPanel({ integrations }: { integrations: IntegrationRow[] }) {
  const t = useT();
  const [editing, setEditing] = useState<IntegrationRow | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">{t("web.admin.economics.integrations.title")}</CardTitle>
        {!adding ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setAdding(true);
              setEditing(null);
            }}
          >
            {t("web.admin.economics.integrations.add")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {adding ? (
          <IntegrationForm initial={blankIntegrationValues()} onDone={() => setAdding(false)} />
        ) : null}
        {editing ? (
          <IntegrationForm
            key={editing.id}
            initial={integrationFormValuesFrom(editing)}
            onDone={() => setEditing(null)}
          />
        ) : null}
        <IntegrationsTable
          rows={integrations}
          onEdit={(row) => {
            setEditing(row);
            setAdding(false);
          }}
        />
      </CardContent>
    </Card>
  );
}
