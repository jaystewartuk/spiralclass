import { Heading } from "@/components/ui/heading";
import { requireSuperuser } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { getT } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import {
  hasAnthropicCreds,
  hasBillingCreds,
  hasGoogleAuthCreds,
  hasGoogleCalendarCreds,
  hasInngestCreds,
  hasResendCreds,
  hasStripeCreds,
  serverEnv,
} from "@/lib/env";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableShell,
} from "@/components/ui/table";

export default async function AdminIntegrationsPage() {
  await requireSuperuser();
  const t = await getT();

  const env = serverEnv();
  // Auto-reconcile credentials live on the Wise INSTRUMENT since D-113 —
  // it is an instrument capability, not a teacher one.
  const wiseConnectedTeachers = await prisma.teacherPayoutInstrument.count({
    where: { kind: "wise", wiseApiProfileId: { not: null } },
  });

  const rows: Array<{ name: string; ok: boolean; detail?: string }> = [
    { name: "Stripe", ok: hasStripeCreds(), detail: t("web.admin.integrations.stripe") },
    {
      name: "Stripe Billing (subscriptions)",
      ok: hasBillingCreds(),
      detail: t("web.admin.integrations.stripeBilling"),
    },
    {
      name: "Wise",
      ok: wiseConnectedTeachers > 0,
      detail: t("web.admin.integrations.wise", { count: wiseConnectedTeachers }),
    },
    { name: "Resend (email)", ok: hasResendCreds(), detail: t("web.admin.integrations.resend") },
    { name: "Inngest", ok: hasInngestCreds(), detail: t("web.admin.integrations.inngest") },
    { name: "Sentry", ok: Boolean(env.SENTRY_DSN), detail: t("web.admin.integrations.sentry") },
    { name: "PostHog", ok: Boolean(env.POSTHOG_KEY), detail: t("web.admin.integrations.posthog") },
    {
      name: "Google Calendar",
      ok: hasGoogleCalendarCreds(),
      detail: t("web.admin.integrations.googleCalendar"),
    },
    {
      name: "Google Sign-In",
      ok: hasGoogleAuthCreds(),
      detail: t("web.admin.integrations.googleSignIn"),
    },
    {
      name: "Anthropic (Claude)",
      ok: hasAnthropicCreds(),
      detail: t("web.admin.integrations.anthropic"),
    },
    {
      name: "better-auth",
      ok: Boolean(env.BETTER_AUTH_SECRET),
      detail: t("web.admin.integrations.betterAuth"),
    },
  ];

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.integrations.title")} />
        <p className="text-muted-foreground text-sm">{t("web.admin.integrations.subtitle")}</p>
      </header>

      <TableShell>
        <Table className="table-stack">
          <TableHeader>
            <TableRow>
              <TableHead>{t("web.admin.integrations.service")}</TableHead>
              <TableHead>{t("web.admin.staff.status")}</TableHead>
              <TableHead>{t("web.admin.integrations.notes")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.name}>
                <TableCell data-label={t("web.admin.integrations.service")} className="font-medium">
                  {r.name}
                </TableCell>
                <TableCell data-label={t("web.admin.staff.status")}>
                  {r.ok ? (
                    <Badge variant="success">{t("web.admin.integrations.configured")}</Badge>
                  ) : (
                    <Badge variant="warning">{t("web.admin.integrations.stub")}</Badge>
                  )}
                </TableCell>
                <TableCell
                  data-label={t("web.admin.integrations.notes")}
                  className="text-muted-foreground text-xs"
                >
                  {r.detail}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableShell>

      <section className="space-y-2 text-sm">
        <Heading level={3} as="h2">
          {t("web.admin.integrations.environment")}
        </Heading>
        <p>
          NODE_ENV: <code>{env.NODE_ENV}</code>
        </p>
        <p>
          APP_URL: <code>{env.APP_URL}</code>
        </p>
      </section>
    </div>
  );
}
