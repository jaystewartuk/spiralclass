import { requireAdmin, getAdminEmails } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { buildTeacherWhere, STALLED_TEACHER_DAYS } from "@/lib/admin-filters";
import { prisma } from "@/lib/prisma";
import { WISE_API_CONNECTED_WHERE } from "@/lib/payments/payout-rail-where";
import { INSTRUMENT_READINESS_SELECT } from "@/lib/marketplace-ready";
import { resolveSort, type SortColumns } from "@/lib/table-sort";
import { resolvePage } from "@/lib/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { CategoryBarChart, CHART_CATEGORY_COLORS } from "@/components/ui/chart";
import { toBarSeries, type ChartDatum } from "@spiralclass/shared";
import type { Prisma } from "@prisma/client";
import { getT } from "@/lib/i18n";
import { TeachersTable } from "./teachers-table";

const PAGE_SIZE = 100;

// The readiness columns every listing needs, plus the one admin-only fact this
// page shows on top of them (whether Wise auto-reconcile is wired up). A named
// constant so `satisfies` checks the field names: an inline `select` nested
// inside a larger one is not excess-property-checked, which is how
// `schemeId`/`details` outlived the D-145 migration that dropped them.
const ADMIN_INSTRUMENT_SELECT = {
  ...INSTRUMENT_READINESS_SELECT,
  wiseApiProfileId: true,
} as const satisfies Prisma.TeacherPayoutInstrumentSelect;

const SORT_COLUMNS: SortColumns<Prisma.TeacherOrderByWithRelationInput> = {
  name: (dir) => ({ name: dir }),
  joined: (dir) => ({ createdAt: dir }),
  students: (dir) => ({ teacherStudents: { _count: dir } }),
  packages: (dir) => ({ packages: { _count: dir } }),
  bookings: (dir) => ({ bookings: { _count: dir } }),
};

type Search = {
  q?: string;
  onboarded?: string;
  disabled?: string;
  stalled?: string;
  sort?: string;
  dir?: string;
  page?: string;
};

export default async function AdminTeachersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireAdmin("support");
  const t = await getT();
  const params = await searchParams;
  const { q, onboarded, disabled, stalled } = params;
  const query = (q ?? "").trim();
  const { orderBy } = resolveSort(params, SORT_COLUMNS, "joined");
  const adminEmails = await getAdminEmails();
  const where = buildTeacherWhere({ q, onboarded, disabled, stalled }, adminEmails);
  // From the onboarding activation audit — independent of the `stalled`
  // filter chip so the stat always shows the true count even when a
  // different filter is active.
  const stalledWhere = buildTeacherWhere({ q, onboarded, disabled, stalled: "yes" }, adminEmails);

  const [
    total,
    stripeConnectedCount,
    stripePendingCount,
    wiseConnectedCount,
    onboardedCount,
    stalledCount,
  ] = await Promise.all([
    prisma.teacher.count({ where }),
    prisma.teacher.count({
      where: { ...where, stripeChargesEnabled: true, stripePayoutsEnabled: true },
    }),
    prisma.teacher.count({
      where: {
        ...where,
        stripeAccountId: { not: null },
        NOT: { stripeChargesEnabled: true, stripePayoutsEnabled: true },
      },
    }),
    prisma.teacher.count({ where: { ...where, ...WISE_API_CONNECTED_WHERE } }),
    prisma.teacher.count({ where: { ...where, onboardingCompleteAt: { not: null } } }),
    prisma.teacher.count({ where: stalledWhere }),
  ]);
  const onboardingMix: ChartDatum[] = toBarSeries(
    { onboarded: onboardedCount, pending: total - onboardedCount },
    ["onboarded", "pending"] as const,
    { onboarded: t("web.admin.teachers.onboardedLabel"), pending: t("web.admin.teachers.pending") },
    { onboarded: CHART_CATEGORY_COLORS[0], pending: CHART_CATEGORY_COLORS[1] },
  );
  const connectionMix: ChartDatum[] = toBarSeries(
    {
      stripeConnected: stripeConnectedCount,
      stripePending: stripePendingCount,
      stripeNone: total - stripeConnectedCount - stripePendingCount,
      wiseConnected: wiseConnectedCount,
    },
    ["stripeConnected", "stripePending", "stripeNone", "wiseConnected"] as const,
    {
      stripeConnected: t("web.admin.teachers.stripeConnectedChart"),
      stripePending: t("web.admin.teachers.stripePendingChart"),
      stripeNone: t("web.admin.teachers.stripeNoneChart"),
      wiseConnected: t("web.admin.teachers.wiseConnectedChart"),
    },
    {
      stripeConnected: CHART_CATEGORY_COLORS[0],
      stripePending: CHART_CATEGORY_COLORS[1],
      stripeNone: CHART_CATEGORY_COLORS[2],
      wiseConnected: CHART_CATEGORY_COLORS[3],
    },
  );
  const pageState = resolvePage(params, total, PAGE_SIZE);
  const teachers = await prisma.teacher.findMany({
    where,
    orderBy,
    skip: pageState.skip,
    take: pageState.take,
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      onboardingCompleteAt: true,
      disabledAt: true,
      stripeAccountId: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      pricingCurrency: true,
      // Marketplace-readiness sub-signals, for the client-side "stalled"
      // filter mirror (matchesTeacherFilters).
      photoPath: true,
      bio: true,
      templatesTouchedAt: true,
      availabilityTouchedAt: true,
      // D-113: the payout rail is a relation, and `wiseApiProfileId` (the
      // auto-reconcile credential) moved onto the Wise instrument with it.
      payoutInstruments: { select: ADMIN_INSTRUMENT_SELECT },
      _count: {
        select: { bookings: true, packages: true, teacherStudents: true },
      },
    },
  });

  const exportParams = new URLSearchParams(
    Object.entries({
      q: query,
      onboarded: onboarded ?? "",
      disabled: disabled ?? "",
      stalled: stalled ?? "",
    }).filter(([, v]) => v),
  ).toString();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageHeader title={t("web.admin.teachers.title")} />
          <p className="text-muted-foreground text-sm">
            {t("web.admin.teachers.matchingCount", { count: total.toLocaleString() })}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/admin/export/teachers${exportParams ? `?${exportParams}` : ""}`}>
            {t("web.admin.teachers.exportCsv")}
          </a>
        </Button>
      </header>

      {/* The re-engagement
          candidate list — onboarded ({STALLED_TEACHER_DAYS}+ days ago) but
          still not Marketplace Ready (missing profile, offer/schedule review,
          or a payout rail). Just the query surfaced as an admin-visible list
          for now, per the audit's own recommendation to validate it against
          real data before building an automated nudge. */}
      {stalledCount > 0 && (
        <a
          href="?stalled=yes"
          className="border-warning/30 bg-warning-bg text-warning block rounded-md border px-4 py-3 text-sm hover:underline"
        >
          {t("web.admin.teachers.stalledCallout", {
            count: stalledCount.toLocaleString(),
            days: String(STALLED_TEACHER_DAYS),
          })}
        </a>
      )}

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
            <CardTitle className="text-lg">{t("web.admin.teachers.connectionMixTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryBarChart data={connectionMix} />
          </CardContent>
        </Card>
      </div>

      <TeachersTable initialTeachers={teachers} params={params} />

      {total > 0 ? <Pagination state={pageState} params={params} /> : null}
    </div>
  );
}
