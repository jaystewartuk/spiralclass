import type { Package, Teacher } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible } from "@/components/ui/collapsible";
import { HelpTip } from "@/components/help-tip";
import { PackageDetailsSheet } from "@/components/packages/package-details-sheet";
import { prisma } from "@/lib/prisma";
import { minorUnitsToMajor, formatMinorUnits } from "@/lib/money";
import { classesLeftToTeach } from "@/lib/package-usage";
import { formatZonedDateCompact, formatZonedDateTime } from "@/lib/date-display";
import { overrideActionLabel } from "@/lib/overrides/labels";
import type { AppLocale, StringKey, TFunction } from "@/lib/i18n-translate";
import { AddPackageForm, type PackageTemplateOption } from "./add-package-form";
import { CustomPriceForm } from "./custom-price-form";
import { DeletePackageButton } from "./delete-package-button";
import { EditPackageForm } from "./edit-package-form";
import { PackagePauseButton } from "./package-pause-button";

/**
 * Everything about money for one student: what she has bought, what is left in
 * it, what she is agreed to pay next time, and the log of adjustments.
 *
 * THE PACKAGE ROW IS THE CHANGE HERE. It used to be two lines of interpuncted
 * micro-text ("Package of 10 · 6 available · $1,500.00 MXN · expires
 * 2026-10-03") with a complete edit form expanded underneath it, for every
 * package, always. The number a teacher is actually looking for — how many
 * classes are left — was the third value in a run of five, at the smallest
 * size on the page. It leads now, and the form it used to sit above opens when
 * she asks for it.
 *
 * The expiry date was also being printed as `toISOString().slice(0, 10)`,
 * which is a UTC calendar date: a package expiring at 23:00 in Mexico City
 * showed tomorrow's date. It goes through the teacher's zone now, like every
 * other date in the product.
 */

const STATUS_LABEL_KEY: Record<string, StringKey> = {
  active: "web.dashboard.students.package.status.active",
  paused: "web.dashboard.students.package.status.paused",
  expired: "web.dashboard.students.package.status.expired",
  refunded: "web.dashboard.students.package.status.refunded",
  pending: "web.dashboard.students.package.status.pending",
};

// Status is never carried by hue alone (D-140) — every one of these badges
// prints its own word. The variant is the second channel, not the only one.
const STATUS_VARIANT: Record<string, NonNullable<BadgeProps["variant"]>> = {
  active: "success",
  paused: "warning",
  expired: "secondary",
  refunded: "secondary",
  pending: "info",
};

function packageStatusLabel(status: string, t: TFunction): string {
  const key = STATUS_LABEL_KEY[status];
  return key ? t(key) : status;
}

type PackageWithTemplate = Package & { template: { name: string } | null };

function PackageRow({
  pkg,
  scheduled,
  committed,
  deletable,
  teacherTimezone,
  locale,
  t,
}: {
  pkg: PackageWithTemplate;
  scheduled: number;
  committed: number;
  deletable: boolean;
  teacherTimezone: string;
  locale: AppLocale;
  t: TFunction;
}) {
  const left = classesLeftToTeach({
    classesTotal: pkg.classesTotal,
    classesUsed: pkg.classesUsed,
    scheduled,
  });
  // Narrowed rather than a boolean, so the pause control's own union type
  // ("active" | "paused") is satisfied by the value rather than by a flag TS
  // cannot follow.
  const pausable = pkg.status === "active" || pkg.status === "paused" ? pkg.status : null;

  return (
    <li className="rounded-md border">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-4">
        <div className="min-w-0 flex-1 basis-48">
          <PackageDetailsSheet packageId={pkg.id} className="-m-1 w-auto p-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {pkg.template?.name ?? t("web.dashboard.students.package.packageLabel")}
              </span>
              <Badge variant={STATUS_VARIANT[pkg.status] ?? "secondary"}>
                {packageStatusLabel(pkg.status, t)}
              </Badge>
            </span>
            {/* The one figure the row exists for, given the size and the
                alignment that lets a column of packages be read down. */}
            <span className="mt-1 flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tabular-nums">{left}</span>
              <span className="text-muted-foreground text-sm">
                {t("web.dashboard.students.package.leftOfTotal", {
                  total: String(pkg.classesTotal),
                })}
              </span>
            </span>
            <span className="text-muted-foreground mt-1 block text-sm">
              {formatMinorUnits(pkg.pricePaidMinorUnits, pkg.currency)}
              {" · "}
              {pkg.expiresAt
                ? t("web.dashboard.students.package.expiresOn", {
                    date: formatZonedDateCompact(pkg.expiresAt, teacherTimezone, locale),
                  })
                : t("web.dashboard.students.package.noExpiration")}
            </span>
          </PackageDetailsSheet>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {pausable && <PackagePauseButton packageId={pkg.id} status={pausable} />}
          {deletable && <DeletePackageButton packageId={pkg.id} />}
        </div>
      </div>

      {/* Closed by default. Four packages used to mean four complete edit
          forms — sixteen inputs — open on arrival. */}
      {pausable && (
        <div className="border-t px-4 py-3">
          <Collapsible title={t("web.dashboard.students.package.editPackage")} defaultOpen={false}>
            <EditPackageForm
              packageId={pkg.id}
              classesTotal={pkg.classesTotal}
              classesRemaining={pkg.classesTotal - pkg.classesUsed}
              classDurationMin={pkg.classDurationMin}
              expiresOn={
                pkg.expiresAt ? formatInTimeZone(pkg.expiresAt, teacherTimezone, "yyyy-MM-dd") : ""
              }
              // Currency-aware, so a 0-decimal price (CLP, JPY, KRW, VND) is
              // not divided by a hundred it never had. See CLAUDE.md on
              // minor units.
              pricePesos={String(minorUnitsToMajor(pkg.pricePaidMinorUnits, pkg.currency))}
              committedBookings={committed}
            />
          </Collapsible>
        </div>
      )}
    </li>
  );
}

export async function PackagesTab({
  studentId,
  teacher,
  locale,
  t,
  packages,
  scheduledByPackage,
}: {
  studentId: string;
  teacher: Teacher;
  locale: AppLocale;
  t: TFunction;
  packages: PackageWithTemplate[];
  scheduledByPackage: Map<string, number>;
}) {
  const [
    committedCounts,
    allBookingCounts,
    paymentCounts,
    packageTemplates,
    agreedPrices,
    overrides,
  ] = await Promise.all([
    // Committed bookings per package (reserved or consumed). This is the
    // floor for classesUsed: the edit form can't push classes-left so high
    // that the committed count would drop below what is already booked.
    prisma.booking.groupBy({
      by: ["packageId"],
      where: { teacherId: teacher.id, studentId, countsAgainstPackage: true },
      _count: { _all: true },
    }),
    // A package is deletable — the "created by accident" path — only when
    // nothing real hangs off it: no bookings of any status (scheduling
    // history, and the FK is Restrict) and no payments (money on record,
    // and the FK is Cascade).
    prisma.booking.groupBy({
      by: ["packageId"],
      where: { teacherId: teacher.id, studentId },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ["packageId"],
      where: { package: { teacherId: teacher.id, studentId } },
      _count: { _all: true },
    }),
    prisma.packageTemplate.findMany({
      where: { teacherId: teacher.id, archived: false },
      orderBy: { priceMinorUnits: "asc" },
      select: {
        id: true,
        name: true,
        classCount: true,
        classDurationMin: true,
        priceMinorUnits: true,
      },
    }),
    // Grandfathering is per package, so the form needs every sellable
    // package plus whatever this student has already been agreed for.
    prisma.teacherStudentTemplatePrice.findMany({
      where: { teacherId: teacher.id, studentId },
      select: { templateId: true, priceMinorUnits: true },
    }),
    prisma.override.findMany({
      where: { teacherId: teacher.id, targetType: "student", targetId: studentId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const countBy = (rows: { packageId: string | null; _count: { _all: number } }[]) => {
    const map = new Map<string, number>();
    for (const row of rows) if (row.packageId) map.set(row.packageId, row._count._all);
    return map;
  };
  const committedByPackage = countBy(committedCounts);
  const allBookingsByPackage = countBy(allBookingCounts);
  const paymentsByPackage = countBy(paymentCounts);

  const currency = teacher.pricingCurrency;
  const templateOptions: PackageTemplateOption[] = packageTemplates.map((tpl) => ({
    id: tpl.id,
    name: tpl.name,
    classCount: tpl.classCount,
    classDurationMin: tpl.classDurationMin,
    // Currency-aware for the same reason as the edit form above: a hardcoded
    // /100 turns ¥8,000 into ¥800,000 in the box the teacher then saves.
    pricePesos: String(minorUnitsToMajor(tpl.priceMinorUnits, currency)),
  }));

  const agreedByTemplate: Record<string, number> = Object.fromEntries(
    agreedPrices.map((row) => [row.templateId, row.priceMinorUnits]),
  );

  return (
    <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
            <div className="space-y-1.5">
              <CardTitle className="text-lg" as="h2">
                {t("web.dashboard.students.section.packages")}
              </CardTitle>
              <CardDescription>
                {t("web.dashboard.students.package.sectionDescription")}
              </CardDescription>
            </div>
            <AddPackageForm studentId={studentId} templates={templateOptions} />
          </CardHeader>
          <CardContent>
            {packages.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t("web.dashboard.students.package.noneYet")}
              </p>
            ) : (
              <ul className="space-y-3">
                {packages.map((pkg) => (
                  <PackageRow
                    key={pkg.id}
                    pkg={pkg}
                    scheduled={scheduledByPackage.get(pkg.id) ?? 0}
                    committed={committedByPackage.get(pkg.id) ?? 0}
                    deletable={
                      (allBookingsByPackage.get(pkg.id) ?? 0) === 0 &&
                      (paymentsByPackage.get(pkg.id) ?? 0) === 0
                    }
                    teacherTimezone={teacher.timezone}
                    locale={locale}
                    t={t}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {overrides.length > 0 && (
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg" as="h2">
                {t("web.dashboard.students.accountAdjustments")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {overrides.map((o) => (
                  <li key={o.id} className="rounded-md border px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      {/* Was the raw column value — a teacher's adjustment log
                          literally read `set_custom_price`. */}
                      <span className="font-medium">{overrideActionLabel(o.action, t)}</span>
                      <span className="text-muted-foreground text-sm">
                        {formatZonedDateTime(o.createdAt, teacher.timezone, locale)}
                      </span>
                    </div>
                    <p className="text-muted-foreground">{o.reason}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      <aside>
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg" as="h2">
              {t("students.detail.customPrice")}
              <HelpTip
                label={t("web.dashboard.students.price.helpLabel")}
                text={t("web.dashboard.students.price.helpText")}
              />
            </CardTitle>
            <CardDescription>{t("web.dashboard.students.price.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <CustomPriceForm
              studentId={studentId}
              templates={packageTemplates.map((tpl) => ({
                id: tpl.id,
                name: tpl.name,
                priceMinorUnits: tpl.priceMinorUnits,
              }))}
              current={agreedByTemplate}
            />
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
