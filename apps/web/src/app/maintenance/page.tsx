import { Heading } from "@/components/ui/heading";
import { getT } from "@/lib/i18n";
import { Logo } from "@/components/brand/logo";
import { maintenanceMessage, maintenanceUntil } from "@/lib/maintenance";
import { RetryButton } from "./retry-button";

// The maintenance wall (D-76). Middleware rewrites every non-allowlisted page
// request here with a 503 while MAINTENANCE_MODE is on. Copy comes from the
// shared catalog; an operator can override the body with MAINTENANCE_MESSAGE
// and add an ETA with MAINTENANCE_UNTIL.
export const metadata = { robots: { index: false, follow: false } };

export default async function MaintenancePage() {
  const t = await getT();
  const message = maintenanceMessage();
  const until = maintenanceUntil();
  return (
    <main className="container flex min-h-dvh flex-col items-center justify-center gap-6 py-12 text-center">
      <Logo size="md" />
      <div className="max-w-md space-y-3">
        <Heading level={1}>{t("maintenance.title")}</Heading>
        <p className="text-muted-foreground">{message ?? t("maintenance.body")}</p>
        {until ? <p className="text-sm text-muted-foreground">{until}</p> : null}
      </div>
      <RetryButton label={t("maintenance.cta")} />
    </main>
  );
}
