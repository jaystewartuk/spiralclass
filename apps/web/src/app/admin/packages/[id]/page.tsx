import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { formatMinorUnits } from "@/lib/money";
import { stripePaymentIntentUrl } from "@/lib/external-links";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableShell,
} from "@/components/ui/table";
import { CancelPackageForm, ExtendPackageForm } from "./actions-form";
import { BackLink } from "@/components/back-link";
import { getT } from "@/lib/i18n";

export default async function AdminPackageDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin("support");
  const t = await getT();
  const { id } = await params;

  const pkg = await prisma.package.findUnique({
    where: { id },
    include: {
      teacher: { select: { id: true, name: true, email: true } },
      student: { select: { id: true, name: true, email: true } },
      template: { select: { name: true, expirationMonths: true } },
      payments: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amountMinorUnits: true,
          status: true,
          providerPaymentId: true,
          paidAt: true,
          refundedAt: true,
          createdAt: true,
        },
      },
      bookings: {
        orderBy: { scheduledStart: "desc" },
        take: 50,
        select: {
          id: true,
          status: true,
          scheduledStart: true,
          scheduledEnd: true,
        },
      },
    },
  });
  if (!pkg) notFound();

  const remaining = pkg.classesTotal - pkg.classesUsed;

  return (
    <div className="space-y-6">
      <BackLink
        href={`/admin/teachers/${pkg.teacher.id}`}
        label={t("web.admin.packages.teacherLabel")}
      />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Heading level={2} as="h1">
            {pkg.template?.name ?? t("web.admin.packages.customPackage")}
          </Heading>
          <p className="text-muted-foreground text-sm">
            <Link className="hover:underline" href={`/admin/teachers/${pkg.teacher.id}`}>
              {pkg.teacher.name}
            </Link>
            {" → "}
            <Link className="hover:underline" href={`/admin/students/${pkg.student.id}`}>
              {pkg.student.name}
            </Link>
          </p>
        </div>
        <span className="rounded-full border px-3 py-1 text-xs font-medium">{pkg.status}</span>
      </header>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Stat label={t("web.admin.packages.totalClasses")} value={pkg.classesTotal} />
        <Stat label={t("web.admin.packages.used")} value={pkg.classesUsed} />
        <Stat label={t("web.admin.packages.remaining")} value={remaining} />
        <Stat
          label={t("web.admin.packages.expires")}
          value={
            pkg.expiresAt
              ? new Date(pkg.expiresAt).toLocaleDateString()
              : t("web.admin.packages.noExpirationShort")
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.packages.cancelPackage")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CancelPackageForm packageId={pkg.id} alreadyRefunded={pkg.status === "refunded"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.admin.packages.extendExpiration")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ExtendPackageForm packageId={pkg.id} hasExpiry={Boolean(pkg.expiresAt)} />
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <Heading level={3} as="h2">
          {t("web.admin.payments.title")}
        </Heading>
        {pkg.payments.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("web.admin.packages.noPayments")}</p>
        ) : (
          <TableShell>
            <Table className="table-stack">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("web.admin.common.date")}</TableHead>
                  <TableHead>{t("web.admin.common.status")}</TableHead>
                  <TableHead className="text-right">{t("web.admin.common.amount")}</TableHead>
                  <TableHead>{t("web.admin.common.stripe")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pkg.payments.map((p) => {
                  const stripeUrl = stripePaymentIntentUrl(p.providerPaymentId);
                  return (
                    <TableRow key={p.id}>
                      <TableCell
                        data-label={t("web.admin.common.date")}
                        className="text-muted-foreground text-xs"
                      >
                        {new Date(p.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell data-label={t("web.admin.common.status")}>{p.status}</TableCell>
                      <TableCell
                        data-label={t("web.admin.common.amount")}
                        className="text-right font-medium"
                      >
                        {formatMinorUnits(p.amountMinorUnits)}
                      </TableCell>
                      <TableCell data-label={t("web.admin.common.stripe")}>
                        {stripeUrl ? (
                          <a
                            href={stripeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs underline"
                          >
                            ↗ {t("web.admin.common.open")}
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableShell>
        )}
      </section>

      <section className="space-y-3">
        <Heading level={3} as="h2">
          {t("web.admin.packages.bookings")}
        </Heading>
        {pkg.bookings.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("web.admin.packages.noBookings")}</p>
        ) : (
          <TableShell>
            <Table className="table-stack">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("web.admin.common.start")}</TableHead>
                  <TableHead>{t("web.admin.common.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pkg.bookings.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell
                      data-label={t("web.admin.common.start")}
                      className="text-muted-foreground text-xs"
                    >
                      {new Date(b.scheduledStart).toLocaleString()}
                    </TableCell>
                    <TableCell data-label={t("web.admin.common.status")}>{b.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableShell>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}
