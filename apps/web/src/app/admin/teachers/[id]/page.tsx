import { Heading } from "@/components/ui/heading";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { requireSuperuser } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryBarChart } from "@/components/ui/chart";
import { formatMinorUnits } from "@/lib/money";
import { entitlementsFor } from "@/lib/subscriptions/entitlements";
import { notificationStatusChartData } from "@/lib/notifications/chart";
import { TeacherModerationForm } from "./moderation-form";
import { SubscriptionForm } from "./subscription-form";
import { BackLink } from "@/components/back-link";
import { getT } from "@/lib/i18n";

export default async function AdminTeacherDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSuperuser();
  const { id } = await params;
  const t = await getT();

  const teacher = await prisma.teacher.findUnique({
    where: { id },
    include: {
      packageTemplates: { where: { archived: false } },
      // Auto-reconcile credentials moved onto the Wise instrument (D-113).
      // Selected explicitly rather than through INSTRUMENT_SELECT, which
      // deliberately omits the credential columns.
      payoutInstruments: { select: { kind: true, enabled: true, wiseApiProfileId: true } },
      _count: { select: { bookings: true, packages: true, teacherStudents: true } },
    },
  });
  if (!teacher) notFound();

  const wiseApiProfileId =
    teacher.payoutInstruments.find((i) => i.kind === "wise")?.wiseApiProfileId ?? null;

  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const bookingUrl = `${appUrl}/b/${teacher.bookingSlug}`;

  const [
    subscription,
    paymentsAgg,
    refundsCount,
    recentPayments,
    notificationStatusCounts,
    recentNotifications,
  ] = await Promise.all([
    prisma.teacherSubscription.findUnique({ where: { teacherId: id } }),
    prisma.payment.aggregate({
      where: { package: { teacherId: id }, status: "paid" },
      _sum: { amountMinorUnits: true },
      _count: { _all: true },
    }),
    prisma.payment.count({ where: { package: { teacherId: id }, status: "refunded" } }),
    prisma.payment.findMany({
      where: { package: { teacherId: id } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        amountMinorUnits: true,
        status: true,
        createdAt: true,
        package: { select: { student: { select: { name: true } } } },
      },
    }),
    prisma.notification.groupBy({
      by: ["status"],
      where: { teacherId: id },
      _count: { _all: true },
    }),
    prisma.notification.findMany({
      where: { teacherId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        templateName: true,
        channel: true,
        status: true,
        recipientType: true,
        recipientId: true,
        createdAt: true,
      },
    }),
  ]);

  // recipientType="student" rows point at one of this teacher's students;
  // resolve those names for display (recipientType="teacher" rows are the
  // teacher themselves, already in scope).
  const notifStudentIds = recentNotifications
    .filter((n) => n.recipientType === "student")
    .map((n) => n.recipientId);
  const notifStudents = notifStudentIds.length
    ? await prisma.student.findMany({
        where: { id: { in: notifStudentIds } },
        select: { id: true, name: true },
      })
    : [];
  const notifStudentMap = new Map(notifStudents.map((s) => [s.id, s.name]));
  const notificationChartData = notificationStatusChartData(
    Object.fromEntries(notificationStatusCounts.map((s) => [s.status, s._count._all])),
  );

  return (
    <div className="space-y-6">
      <BackLink href="/admin/teachers" label={t("web.admin.teachers.title")} />
      <header>
        <PageHeader title={teacher.name} />
        <p className="text-sm text-muted-foreground">
          {teacher.email} · {teacher.timezone} · {t("web.admin.teachers.slugLabel")}{" "}
          <code>{teacher.bookingSlug}</code>
        </p>
        <p className="mt-1 text-sm">
          <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="underline">
            {bookingUrl} ↗
          </a>
        </p>
        {teacher.disabledAt && (
          <p className="mt-2">
            <Badge variant="warning">
              {t("web.admin.disabledBadge")} {teacher.disabledAt.toISOString().slice(0, 10)}
              {teacher.disabledReason ? ` — ${teacher.disabledReason}` : ""}
            </Badge>
          </p>
        )}
      </header>

      <section className="space-y-2">
        <Heading level={3} as="h2">
          {t("web.admin.teachers.moderationTitle")}
        </Heading>
        <TeacherModerationForm teacherId={teacher.id} disabled={Boolean(teacher.disabledAt)} />
      </section>

      <section className="space-y-2">
        <Heading level={3} as="h2">
          {t("web.admin.teachers.subscriptionTitle")}
        </Heading>
        <div className="grid gap-3 text-sm lg:grid-cols-2 xl:grid-cols-4">
          <Field
            label={t("web.admin.teachers.planLabel")}
            value={subscription?.plan ?? t("web.admin.teachers.planFree")}
          />
          <Field
            label={t("web.admin.statusLabel")}
            value={subscription?.status ?? t("web.admin.teachers.planFree")}
          />
          <Field
            label={t("web.admin.teachers.compedLabel")}
            value={subscription?.comped ? t("web.admin.yes") : t("web.admin.no")}
          />
          <Field
            label={t("web.admin.teachers.trialEndsLabel")}
            value={
              subscription?.trialEndsAt ? subscription.trialEndsAt.toISOString().slice(0, 10) : "—"
            }
          />
          <Field
            label={t("web.admin.teachers.currentPeriodEndLabel")}
            value={
              subscription?.currentPeriodEnd
                ? subscription.currentPeriodEnd.toISOString().slice(0, 10)
                : "—"
            }
          />
          <Field
            label={t("web.admin.teachers.lockedPriceLabel")}
            value={
              subscription?.lockedPriceMinorUnits != null
                ? formatMinorUnits(subscription.lockedPriceMinorUnits)
                : "—"
            }
          />
        </div>
        <SubscriptionForm teacherId={teacher.id} />
        {(() => {
          // Read-only debugging aid — the raw DB row above is what an admin
          // action writes; this is what entitlementsFor() actually resolves
          // it to right now (clock-aware: a stale trialing/past_due row past
          // its window downgrades here before the sweep runs). Support asked
          // "why is this gate failing for this teacher" more than once with
          // no way to answer it except re-deriving the logic by hand — this
          // surfaces the exact object every gate check reads, nothing more.
          const ent = entitlementsFor(subscription, new Date());
          return (
            <div className="grid gap-3 text-sm lg:grid-cols-2 xl:grid-cols-4">
              <Field
                label={t("web.admin.teachers.entitlements.isPro")}
                value={ent.isPro ? t("web.admin.yes") : t("web.admin.no")}
              />
              <Field
                label={t("web.admin.teachers.entitlements.effectiveStatus")}
                value={ent.status}
              />
              <Field
                label={t("web.admin.teachers.entitlements.studentLimit")}
                value={
                  ent.studentLimit === Number.POSITIVE_INFINITY ? "∞" : String(ent.studentLimit)
                }
              />
              <Field
                label={t("web.admin.teachers.entitlements.templateLimit")}
                value={
                  ent.templateLimit === Number.POSITIVE_INFINITY ? "∞" : String(ent.templateLimit)
                }
              />
              <Field
                label={t("web.admin.teachers.entitlements.canScheduleMaterials")}
                value={ent.canScheduleMaterials ? t("web.admin.yes") : t("web.admin.no")}
              />
              <Field
                label={t("web.admin.teachers.entitlements.canCustomPrice")}
                value={ent.canCustomPrice ? t("web.admin.yes") : t("web.admin.no")}
              />
              <Field
                label={t("web.admin.teachers.entitlements.canUseLiveNotes")}
                value={ent.canUseLiveNotes ? t("web.admin.yes") : t("web.admin.no")}
              />
            </div>
          );
        })()}
      </section>

      <div className="grid gap-3 text-sm lg:grid-cols-2 xl:grid-cols-4">
        <Field
          label={t("web.admin.teachers.onboardingLabel")}
          value={
            teacher.onboardingCompleteAt
              ? t("web.admin.teachers.complete")
              : t("web.admin.teachers.pending")
          }
        />
        <Field
          label={t("web.admin.teachers.stripeChargesLabel")}
          value={teacher.stripeChargesEnabled ? t("web.admin.enabled") : t("web.admin.disabled")}
        />
        <Field
          label={t("web.admin.teachers.stripePayoutsLabel")}
          value={teacher.stripePayoutsEnabled ? t("web.admin.enabled") : t("web.admin.disabled")}
        />
        <Field
          label={t("web.admin.teachers.stripeAccountLabel")}
          value={teacher.stripeAccountId ?? "—"}
        />
        <Field
          label={t("web.admin.teachers.wiseLabel")}
          value={wiseApiProfileId ? t("web.admin.connected") : "—"}
          hint={
            wiseApiProfileId
              ? `${t("web.admin.teachers.profileHint")} ${wiseApiProfileId}`
              : undefined
          }
        />
        <Field
          label={t("web.admin.teachers.studentsLabel")}
          value={String(teacher._count.teacherStudents)}
        />
        <Field
          label={t("web.admin.teachers.packagesSoldLabel")}
          value={String(teacher._count.packages)}
        />
        <Field
          label={t("web.admin.teachers.bookingsLabel")}
          value={String(teacher._count.bookings)}
        />
        <Field
          label={t("web.admin.teachers.grossPaidLabel")}
          value={formatMinorUnits(paymentsAgg._sum.amountMinorUnits ?? 0)}
          hint={`${paymentsAgg._count._all} ${t("web.admin.teachers.paidHint")} · ${refundsCount} ${t("web.admin.teachers.refundedHint")}`}
        />
      </div>

      <section className="space-y-2">
        <Heading level={3} as="h2">
          {t("web.admin.teachers.activeTemplatesTitle")}
        </Heading>
        {teacher.packageTemplates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("web.admin.none")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-md border">
            {teacher.packageTemplates.map((tpl) => (
              <li key={tpl.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <div className="font-medium">{tpl.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {tpl.classCount}× {tpl.classDurationMin}m
                    {tpl.expirationMonths
                      ? ` · ${t("web.admin.teachers.expirationMonths", { months: tpl.expirationMonths })}`
                      : ""}
                  </div>
                </div>
                <div className="font-medium">{formatMinorUnits(tpl.priceMinorUnits)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <Heading level={3} as="h2">
          {t("web.admin.teachers.recentPaymentsTitle")}
        </Heading>
        {recentPayments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("web.admin.none")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-md border">
            {recentPayments.map((p) => (
              <li key={p.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <div className="font-medium">{p.package.student.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(p.createdAt).toLocaleString()} · {p.status}
                  </div>
                </div>
                <span className="font-medium">{formatMinorUnits(p.amountMinorUnits)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.notificationsByStatus")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryBarChart data={notificationChartData} />
        </CardContent>
      </Card>

      <section className="space-y-2">
        <Heading level={3} as="h2">
          {t("web.admin.recentNotifications")}
        </Heading>
        {recentNotifications.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("web.admin.none")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-md border">
            {recentNotifications.map((n) => (
              <li key={n.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <div className="font-medium">{n.templateName}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(n.createdAt).toLocaleString()} · {n.channel} ·{" "}
                    {n.recipientType === "teacher"
                      ? teacher.name
                      : (notifStudentMap.get(n.recipientId) ??
                        t("web.admin.teachers.unknownStudent"))}
                  </div>
                </div>
                <Badge variant={n.status === "failed" ? "destructive" : "outline"}>
                  {n.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-all font-medium">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
