"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useT } from "@/components/locale-provider";
import type { EconomicsOverview } from "@/lib/economics/estimate";
import type { EconomicsAssumptionsValues } from "@/lib/economics/assumptions";
import { OverviewPanel } from "./overview-panel";
import { IntegrationsPanel, type IntegrationRow } from "./integrations-panel";
import { UsagePanel, type UsageEntry } from "./usage-panel";

// One nav entry + in-page tabs (D-86 doc's Frontend section), not four route
// segments — keeps the admin sidebar lean. Deep-linkable via `?tab=` so a
// bookmark/share lands on the right panel; state also lives in useState so
// switching tabs doesn't wait on a server round-trip.
const TABS = ["overview", "integrations", "usage"] as const;
type TabKey = (typeof TABS)[number];

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TABS as readonly string[]).includes(value);
}

export function EconomicsTabs({
  overview,
  integrations,
  usageEntries,
  assumptions,
}: {
  overview: EconomicsOverview;
  integrations: IntegrationRow[];
  usageEntries: UsageEntry[];
  assumptions: EconomicsAssumptionsValues;
}) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  const [tab, setTab] = useState<TabKey>(isTabKey(urlTab) ? urlTab : "overview");

  function handleTabChange(next: string) {
    if (!isTabKey(next)) return;
    setTab(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <Tabs value={tab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="overview">{t("web.admin.economics.tabOverview")}</TabsTrigger>
        <TabsTrigger value="integrations">{t("web.admin.economics.tabIntegrations")}</TabsTrigger>
        <TabsTrigger value="usage">{t("web.admin.economics.tabUsage")}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <OverviewPanel overview={overview} assumptions={assumptions} />
      </TabsContent>
      <TabsContent value="integrations">
        <IntegrationsPanel integrations={integrations} />
      </TabsContent>
      <TabsContent value="usage">
        <UsagePanel entries={usageEntries} />
      </TabsContent>
    </Tabs>
  );
}
