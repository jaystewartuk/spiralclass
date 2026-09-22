import { getT } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/page-header";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatGbp } from "@/lib/money";
import { getEconomicsOverview } from "@/lib/economics/estimate";
import { getEconomicsAssumptions } from "@/lib/economics/assumptions";
import { EconomicsTabs } from "./economics-tabs";
import type { UsageEntry } from "./usage-panel";
import type { IntegrationRow } from "./integrations-panel";

// Financial Intelligence estimate layer (D-86, S4) — the /admin/economics
// entry point. One Server Component fetch (Promise.all), one requireAdmin,
// then a client tab shell for Overview / Integrations / Usage. This surface
// is deliberately STANDALONE from /admin/costs (actuals) — see the doc's
// "Estimate-vs-actual confusion" risk note, hence the banner below.
export default async function AdminEconomicsPage() {
  await requireAdmin("finance");
  const t = await getT();

  const [overview, integrationRows, assumptions, usageRows] = await Promise.all([
    getEconomicsOverview(),
    // Raw rows, every column, active-and-inactive — unlike getEconomicsOverview
    // (which reuses the parsed, active-only registry.ts read for the KPI
    // math), the admin CRUD table needs the exact stored JSON so a malformed
    // pricingModel row is editable/fixable rather than hidden behind the
    // fail-soft null the parsed registry would show.
    prisma.integration.findMany({ orderBy: { sortOrder: "asc" } }),
    getEconomicsAssumptions(),
    prisma.usageInput.findMany({
      orderBy: [{ periodMonth: "desc" }, { metric: "asc" }],
      take: 200,
    }),
  ]);

  const allIntegrations: IntegrationRow[] = integrationRows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    category: row.category,
    currency: row.currency,
    purpose: row.purpose,
    pricingModel: row.pricingModel,
    billingModel: row.billingModel,
    notes: row.notes,
    billingUrl: row.billingUrl,
    docsUrl: row.docsUrl,
    active: row.active,
    sortOrder: row.sortOrder,
  }));

  const usageEntries: UsageEntry[] = usageRows.map((row) => ({
    id: row.id,
    metric: row.metric,
    periodMonth: row.periodMonth.toISOString().slice(0, 7),
    value: row.value,
    source: row.source,
    notes: row.notes,
  }));

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.economics.title")} />
        <p className="text-sm text-muted-foreground">{t("web.admin.economics.intro")}</p>
      </header>

      <Alert variant="warning">
        <AlertDescription>{t("web.admin.economics.estimateBanner")}</AlertDescription>
      </Alert>

      <Alert variant="info">
        <AlertDescription>
          {t("web.admin.economics.fxAsOf", { date: assumptions.fxAsOf.toISOString().slice(0, 10) })}
          {" — "}
          {t("web.admin.economics.fxUsd", {
            rate: formatGbp(Math.round(assumptions.fxUsdToGbp * 100)),
          })}
          {", "}
          {t("web.admin.economics.fxMxn", {
            rate: formatGbp(Math.round(assumptions.fxMxnToGbp * 100)),
          })}
          {", "}
          {t("web.admin.economics.fxEur", {
            rate: formatGbp(Math.round(assumptions.fxEurToGbp * 100)),
          })}
        </AlertDescription>
      </Alert>

      <EconomicsTabs
        overview={overview}
        integrations={allIntegrations}
        usageEntries={usageEntries}
        assumptions={assumptions}
      />
    </div>
  );
}
