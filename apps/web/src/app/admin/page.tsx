import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { formatMinorUnits } from "@/lib/money";
import { getTeacherSignupSeries } from "@/lib/admin-metrics";
import {
  CategoryBarChart,
  TrendLineChart,
  CHART_CATEGORY_COLORS,
  CHART_SERIES_COLOR,
} from "@/components/ui/chart";
import { toBarSeries, type ChartDatum } from "@spiralclass/shared";
import { getT } from "@/lib/i18n";

export default async function AdminOverviewPage() {
  // Authoritative gate: the overview renders platform-wide PII (every tenant's
  // counts, names, emails), so it must enforce the admin role + MFA itself
  // rather than lean on the layout shell. The layout no longer gates on MFA.
  await requireAdmin();
  const t = await getT();
  const [
    teachersCount,
    onboardedTeachersCount,
    studentsCount,
    activePackagesCount,
    paidPaymentsAgg,
    refundedPaymentsCount,
    queuedNotifications,
    failedNotifications,
    overridesCount,
    openDisputesCount,
    pendingDeletionsCount,
    recentTeachers,
    recentPayments,
  ] = await Promise.all([
    prisma.teacher.count(),
    prisma.teacher.count({ where: { onboardingCompleteAt: { not: null } } }),
    prisma.student.count(),
    prisma.package.count({ where: { status: "active" } }),
    prisma.payment.aggregate({
      where: { status: "paid" },
      _sum: { amountMinorUnits: true },
      _count: { _all: true },
    }),
    prisma.payment.count({ where: { status: "refunded" } }),
    prisma.notification.count({ where: { status: "queued" } }),
    prisma.notification.count({ where: { status: "failed" } }),
    prisma.override.count(),
    prisma.dispute.count({ where: { isFinal: false } }),
    prisma.accountDeletionRequest.count({ where: { status: "pending" } }),
    prisma.teacher.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, email: true, name: true, createdAt: true, onboardingCompleteAt: true },
    }),
    prisma.payment.findMany({
      where: { status: "paid" },
      orderBy: { paidAt: "desc" },
      take: 5,
      select: {
        id: true,
        amountMinorUnits: true,
        paidAt: true,
        package: {
          select: {
            student: { select: { name: true, email: true } },
            teacher: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  const signupSeries = await getTeacherSignupSeries(6);
  const signupChart: ChartDatum[] = signupSeries.map((p) => ({
    key: p.month,
    label: p.label,
    value: p.count,
    color: CHART_SERIES_COLOR,
  }));

  const onboardingMix: ChartDatum[] = toBarSeries(
    { onboarded: onboardedTeachersCount, pending: teachersCount - onboardedTeachersCount },
    ["onboarded", "pending"] as const,
    { onboarded: t("web.admin.overview.onboarded"), pending: t("web.admin.overview.pending") },
    { onboarded: CHART_CATEGORY_COLORS[0], pending: CHART_CATEGORY_COLORS[1] },
  );

  const notificationHealth: ChartDatum[] = toBarSeries(
    { queued: queuedNotifications, failed: failedNotifications },
    ["queued", "failed"] as const,
    {
      queued: t("web.admin.overview.queuedNotifications"),
      failed: t("web.admin.overview.failedNotifications"),
    },
    { queued: CHART_CATEGORY_COLORS[0], failed: CHART_CATEGORY_COLORS[1] },
  );

  return (
    <div className="space-y-6">
      <header>
        <PageHeader title={t("web.admin.overview.title")} />
        <p className="text-sm text-muted-foreground">{t("web.admin.overview.subtitle")}</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("web.admin.overview.teachers")}
          value={teachersCount}
          hint={t("web.admin.overview.onboardedHint", { count: onboardedTeachersCount })}
        />
        <StatCard label={t("web.admin.overview.students")} value={studentsCount} />
        <StatCard label={t("web.admin.overview.activePackages")} value={activePackagesCount} />
        <StatCard label={t("web.admin.overview.auditOverrides")} value={overridesCount} />
        <StatCard
          label={t("web.admin.overview.grossPaid")}
          value={formatMinorUnits(paidPaymentsAgg._sum.amountMinorUnits ?? 0)}
          hint={t("web.admin.overview.paymentsHint", { count: paidPaymentsAgg._count._all })}
        />
        <StatCard label={t("web.admin.overview.refundedPayments")} value={refundedPaymentsCount} />
        <StatCard label={t("web.admin.overview.queuedNotifications")} value={queuedNotifications} />
        <StatCard
          label={t("web.admin.overview.failedNotifications")}
          value={failedNotifications}
          danger={failedNotifications > 0}
        />
        <StatCard
          label={t("web.admin.overview.openDisputes")}
          value={openDisputesCount}
          danger={openDisputesCount > 0}
        />
        <StatCard label={t("web.admin.overview.pendingDeletions")} value={pendingDeletionsCount} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.overview.signupsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TrendLineChart data={signupChart} />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.common.onboardingMixTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryBarChart data={onboardingMix} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {t("web.admin.overview.notificationHealthTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryBarChart data={notificationHealth} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.overview.newTeachers")}</CardTitle>
          </CardHeader>
          <CardContent>
            {recentTeachers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("web.admin.overview.noneYet")}</p>
            ) : (
              <ul className="divide-y">
                {recentTeachers.map((teacher) => (
                  <li key={teacher.id} className="flex items-center justify-between py-2 text-sm">
                    <Link href={`/admin/teachers/${teacher.id}`} className="hover:underline">
                      <div className="font-medium">{teacher.name}</div>
                      <div className="text-xs text-muted-foreground">{teacher.email}</div>
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {teacher.onboardingCompleteAt
                        ? t("web.admin.overview.onboarded")
                        : t("web.admin.overview.pending")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.overview.recentPayments")}</CardTitle>
          </CardHeader>
          <CardContent>
            {recentPayments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("web.admin.overview.noneYet")}</p>
            ) : (
              <ul className="divide-y">
                {recentPayments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {p.package.student.name} → {p.package.teacher.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {p.paidAt ? new Date(p.paidAt).toLocaleString() : "-"}
                      </div>
                    </div>
                    <span className="font-medium">{formatMinorUnits(p.amountMinorUnits)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
