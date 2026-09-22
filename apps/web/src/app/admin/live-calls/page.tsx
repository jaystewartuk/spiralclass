import { requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { listActiveCalls } from "@/lib/live-calls/service";
import { getT } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { LiveCallsView, type LiveCallsInitialState } from "./live-calls-view";

const log = logger({ surface: "admin-live-calls" });

// Server Component does the first, fast fetch directly (same convention as
// every other admin list page — see admin/teachers/page.tsx) so the page has
// real data before any client JS runs; LiveCallsView then takes over with
// polling (see use-visibility-polling.ts) for the "live" part.
export default async function AdminLiveCallsPage() {
  await requireAdmin("support");
  const t = await getT();

  let initial: LiveCallsInitialState;
  try {
    const result = await listActiveCalls(Date.now());
    initial = result ? { kind: "ready", data: result } : { kind: "not-configured" };
  } catch (err) {
    log.error("failed to load initial live calls state", err);
    initial = { kind: "error" };
  }

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.liveCalls.title")} />
        <p className="text-sm text-muted-foreground">{t("web.admin.liveCalls.subtitle")}</p>
      </header>

      <LiveCallsView initial={initial} />
    </div>
  );
}
