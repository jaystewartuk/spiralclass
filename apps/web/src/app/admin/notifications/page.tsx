import { Heading } from "@/components/ui/heading";
import { requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { resendEmailUrl } from "@/lib/external-links";
import { hasInngestCreds, hasResendCreds } from "@/lib/env";
import { getT } from "@/lib/i18n";
import { resolveSort, type SortColumns } from "@/lib/table-sort";
import { resolvePage } from "@/lib/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryBarChart, CHART_CATEGORY_COLORS } from "@/components/ui/chart";
import { Pagination } from "@/components/ui/pagination";
import { BroadcastForm } from "./broadcast-form";
import { NotificationsTable } from "./notifications-table";
import type { NotificationChannel, NotificationStatus, Prisma } from "@prisma/client";
import { toBarSeries } from "@spiralclass/shared";

const STATUS_COLORS: Record<NotificationStatus, string> = {
  queued: CHART_CATEGORY_COLORS[0],
  sending: CHART_CATEGORY_COLORS[0],
  sent: CHART_CATEGORY_COLORS[1],
  delivered: CHART_CATEGORY_COLORS[2],
  failed: CHART_CATEGORY_COLORS[3],
  suppressed: "hsl(var(--muted-foreground))",
};

const STATUSES: NotificationStatus[] = ["queued", "sent", "delivered", "failed"];
const CHANNELS: NotificationChannel[] = ["push", "email"];
const PAGE_SIZE = 100;

const SORT_COLUMNS: SortColumns<Prisma.NotificationOrderByWithRelationInput> = {
  when: (dir) => ({ createdAt: dir }),
  template: (dir) => ({ templateName: dir }),
  channel: (dir) => ({ channel: dir }),
  status: (dir) => ({ status: dir }),
};

// Expected suppressions share status='failed' in the DB but aren't delivery
// failures — render them distinctly so "the student never got it" reads as
// a deliberate gate, not a broken pipeline.
function suppressionLabel(
  error: string | null,
  t: Awaited<ReturnType<typeof getT>>,
): string | null {
  if (!error) return null;
  if (error === "link-archived") return t("web.admin.notifications.suppressed.archived");
  if (error.startsWith("preference-disabled:")) {
    return t("web.admin.notifications.suppressed.prefDisabled", {
      pref: error.slice("preference-disabled:".length),
    });
  }
  if (error === "undeliverable:email_opt_out")
    return t("web.admin.notifications.suppressed.emailOptOut");
  return null;
}

type Search = {
  q?: string;
  status?: string;
  channel?: string;
  sort?: string;
  dir?: string;
  page?: string;
};

export default async function AdminNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const actor = await requireAdmin("support");
  const t = await getT();
  const params = await searchParams;
  const { q, status, channel } = params;
  const query = (q ?? "").trim();
  const statusFilter = STATUSES.includes(status as NotificationStatus)
    ? (status as NotificationStatus)
    : undefined;
  const channelFilter = CHANNELS.includes(channel as NotificationChannel)
    ? (channel as NotificationChannel)
    : undefined;
  const { orderBy } = resolveSort(params, SORT_COLUMNS, "when");

  const where: Prisma.NotificationWhereInput = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(channelFilter ? { channel: channelFilter } : {}),
    ...(query ? { templateName: { contains: query, mode: "insensitive" } } : {}),
  };

  const resendKind = hasResendCreds() ? "real" : "stub";
  const inngestKind = hasInngestCreds() ? "real" : "stub";

  const [recentTotal, failed, byStatus] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { status: "failed" } }),
    prisma.notification.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const pageState = resolvePage(params, recentTotal, PAGE_SIZE);
  const recent = await prisma.notification.findMany({
    where,
    orderBy,
    skip: pageState.skip,
    take: pageState.take,
    select: {
      id: true,
      templateName: true,
      channel: true,
      status: true,
      languageCode: true,
      error: true,
      providerMessageId: true,
      createdAt: true,
      sentAt: true,
      deliveredAt: true,
      recipientType: true,
      recipientId: true,
    },
  });

  const counts = Object.fromEntries(byStatus.map((b) => [b.status, b._count._all]));
  // Chart only ever renders the 4 statuses the Stat cards above it already
  // show (queued/sent/delivered/failed) — `sending` is a transient claim
  // state and `suppressed` is deliberate non-delivery, neither belongs next
  // to a delivery-health breakdown. Reuses the same per-status labels the
  // Stat cards already resolve, so a status reads the same word everywhere.
  const statusMix = toBarSeries(
    counts as Partial<Record<NotificationStatus, number>>,
    STATUSES,
    {
      queued: t("web.admin.notifications.queued"),
      sent: t("web.admin.notifications.sent"),
      delivered: t("web.admin.notifications.delivered"),
      failed: t("web.admin.notifications.failed"),
    } as Record<NotificationStatus, string>,
    STATUS_COLORS,
  );

  // recipientId/recipientType is a polymorphic pair (no Prisma relation), so
  // the recipient's name/email is resolved with a manual batched lookup
  // rather than an `include`.
  const teacherRecipientIds = recent
    .filter((n) => n.recipientType === "teacher")
    .map((n) => n.recipientId);
  const studentRecipientIds = recent
    .filter((n) => n.recipientType === "student")
    .map((n) => n.recipientId);
  const [recipientTeachers, recipientStudents] = await Promise.all([
    teacherRecipientIds.length
      ? prisma.teacher.findMany({
          where: { id: { in: teacherRecipientIds } },
          select: { id: true, name: true, email: true },
        })
      : [],
    studentRecipientIds.length
      ? prisma.student.findMany({
          where: { id: { in: studentRecipientIds } },
          select: { id: true, name: true, email: true },
        })
      : [],
  ]);
  const recipientTeacherMap = new Map(recipientTeachers.map((t) => [t.id, t]));
  const recipientStudentMap = new Map(recipientStudents.map((s) => [s.id, s]));

  const notificationRows = recent.map((n) => ({
    ...n,
    recipient:
      (n.recipientType === "teacher"
        ? recipientTeacherMap.get(n.recipientId)
        : recipientStudentMap.get(n.recipientId)) ?? null,
    resendUrl: resendEmailUrl(n.providerMessageId),
    suppressed: n.status === "failed" ? suppressionLabel(n.error, t) : null,
  }));

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.notifications.title")} />
        <p className="text-muted-foreground text-sm">{t("web.admin.notifications.subtitle")}</p>
      </header>

      <div className="grid gap-3 lg:grid-cols-4">
        <Stat label={t("web.admin.notifications.queued")} value={counts.queued ?? 0} />
        <Stat label={t("web.admin.notifications.sent")} value={counts.sent ?? 0} />
        <Stat label={t("web.admin.notifications.delivered")} value={counts.delivered ?? 0} />
        <Stat label={t("web.admin.notifications.failed")} value={failed} danger={failed > 0} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.common.statusMixTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryBarChart data={statusMix} />
        </CardContent>
      </Card>

      <section className="space-y-2">
        <Heading level={3} as="h2">
          {t("web.admin.notifications.connections")}
        </Heading>
        <p className="text-muted-foreground text-sm">
          {t("web.admin.notifications.connectionsBody")}
        </p>
        <div className="space-y-2 rounded-md border p-4 text-sm">
          <ConnRow label={t("web.admin.notifications.resendLabel")} kind={resendKind} t={t} />
          <ConnRow label={t("web.admin.notifications.inngestLabel")} kind={inngestKind} t={t} />
        </div>
      </section>

      {actor.role === "superadmin" ? <BroadcastForm /> : null}

      <section className="space-y-3">
        <Heading level={3} as="h2">
          {t("web.admin.notifications.recentTitle")}
        </Heading>
        <NotificationsTable
          initialNotifications={notificationRows}
          statuses={STATUSES}
          channels={CHANNELS}
          params={params}
        />

        {recentTotal > 0 ? <Pagination state={pageState} params={params} /> : null}
      </section>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${danger ? "text-destructive" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function ConnRow({
  label,
  kind,
  t,
}: {
  label: string;
  kind: "stub" | "real";
  t: Awaited<ReturnType<typeof getT>>;
}) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span
        className={
          kind === "real"
            ? "border-success/30 bg-success-bg text-success rounded-full border px-2 py-0.5 text-xs"
            : "bg-muted/40 text-muted-foreground rounded-full border px-2 py-0.5 text-xs"
        }
      >
        {kind === "real" ? t("web.admin.notifications.live") : t("web.admin.notifications.stub")}
      </span>
    </div>
  );
}
