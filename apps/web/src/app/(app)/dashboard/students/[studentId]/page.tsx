import { notFound } from "next/navigation";
import { currencyForTeacher } from "@spiralclass/shared";
import { PageShell } from "@/components/ui/page-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BackLink } from "@/components/back-link";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatMinorUnits } from "@/lib/money";
import { classesLeftToTeach } from "@/lib/package-usage";
import { getDualZoneTime } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { classProximity } from "@/lib/classes-list";
import { parseMaterialsFilter, parseMaterialsGroupBy } from "@/lib/materials/student-materials";
import { GoLiveButton } from "./go-live-button";
import { StudentGlance, StudentIdentity, StudentTabNav } from "./student-detail-header";
import { resolveStudentTab } from "./student-detail-nav";
import { OverviewTab } from "./tab-overview";
import { PackagesTab } from "./tab-packages";
import { LearningTab } from "./tab-learning";
import { MaterialsTab } from "./tab-materials";
import { SettingsTab } from "./tab-settings";

/**
 * One student, five views.
 *
 * WHAT THIS REPLACES. The screen was a single column of eleven Cards, each
 * fully expanded, several of them holding an editing form that was open
 * whether or not anyone was editing: the agreed-price grid for every package
 * in the catalog, the contact form, both profile textareas, the assign-material
 * picker, and a complete edit-package form per package. Roughly four thousand
 * pixels of form for a page whose most common purpose is to answer "how many
 * classes does she have left, and when is the next one". The sticky ten-pill
 * scroll-spy bar it had grown was the tell — a page that ships its own table
 * of contents has already admitted it is too long.
 *
 * THE SHAPE NOW, and why each part is a decision rather than a default:
 *
 *  1. THE HEADER ANSWERS THE QUESTION FIRST. Name, level, contact and the four
 *     numbers (classes left, next class, classes taught, paid to date) render
 *     above the tabs and stay put on all five, because they are what the page
 *     is opened for. None of them existed anywhere on this screen before —
 *     "classes left" had to be read off a package row, and "when is the next
 *     class" was not on the page at all.
 *  2. THE VIEWS ARE URL STATE, not a client widget. `?tab=` survives a
 *     refresh, a bookmark and the back button, every panel stays a Server
 *     Component, and — the reason that matters here — the page fetches only
 *     the tab it is rendering. This used to run fourteen queries on every
 *     load, including the three-source materials history, to paint sections
 *     the reader had not asked for.
 *  3. EDITING IS BEHIND AN AFFORDANCE. Every form that was permanently open is
 *     now opened deliberately. Nothing was removed; the read view of each
 *     section is what renders first.
 *
 * Tenancy: every query below is scoped by `teacherId` from auth, and the page
 * 404s unless a `teacher_students` row joins the two.
 */

/** How many upcoming and past classes the Overview lists before deferring to
 *  the classes screen. Enough to recognise a rhythm, short enough to scan. */
const OVERVIEW_CLASS_LIMIT = 5;

export async function generateMetadata({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  const teacher = await requireOnboardedTeacher();
  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
    select: { student: { select: { name: true } } },
  });
  // The browser tab is how a teacher tells two open students apart; falling
  // back to the section name is better than "SpiralClass" twice.
  return { title: link?.student.name ?? undefined };
}

export default async function TeacherStudentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<{ tab?: string; mf?: string; mg?: string }>;
}) {
  const { studentId } = await params;
  const sp = await searchParams;
  const tab = resolveStudentTab(sp.tab);
  const materialsFilter = parseMaterialsFilter(sp.mf);
  const materialsGroupBy = parseMaterialsGroupBy(sp.mg);

  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const now = new Date();

  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
    include: {
      level: { select: { label: true } },
      student: {
        select: {
          id: true,
          name: true,
          email: true,
          phoneE164: true,
          authUserId: true,
          notificationPrefs: true,
          timezone: true,
        },
      },
    },
  });
  if (!link) notFound();

  // The header's four numbers. Every one is an aggregate rather than a row
  // fetch, so the strip costs the same on a student with three classes and one
  // with three hundred.
  const [packages, scheduledCounts, nextBooking, taughtCount, paidByCurrency] = await Promise.all([
    prisma.package.findMany({
      where: { teacherId: teacher.id, studentId },
      orderBy: { purchasedAt: "desc" },
      include: { template: { select: { name: true } } },
    }),
    // Scheduled bookings per package, so "classes left to teach" here matches
    // the roster's figure exactly (see lib/package-usage.ts for why the two
    // must agree and what the number means).
    prisma.booking.groupBy({
      by: ["packageId"],
      where: { teacherId: teacher.id, studentId, status: "scheduled" },
      _count: { _all: true },
    }),
    // The next class is the next one that has not ENDED — a class in progress
    // is the most relevant thing on the page, and filtering on `scheduledStart`
    // would drop it the moment it began.
    prisma.booking.findFirst({
      where: {
        teacherId: teacher.id,
        studentId,
        status: "scheduled",
        scheduledEnd: { gte: now },
      },
      orderBy: { scheduledStart: "asc" },
      select: { id: true, scheduledStart: true, scheduledEnd: true },
    }),
    prisma.booking.count({
      where: { teacherId: teacher.id, studentId, status: "completed" },
    }),
    // Grouped by currency rather than summed flat: a teacher who changed her
    // pricing currency has rows in both, and adding those integers together
    // would produce a number that is not money in any denomination.
    prisma.payment.groupBy({
      by: ["currency"],
      where: { package: { teacherId: teacher.id, studentId }, status: "paid" },
      _sum: { amountMinorUnits: true },
      _count: { _all: true },
    }),
  ]);

  const scheduledByPackage = new Map<string, number>();
  for (const row of scheduledCounts) {
    if (row.packageId) scheduledByPackage.set(row.packageId, row._count._all);
  }

  const drawablePackages = packages.filter((p) => p.status === "active");
  const classesLeft = drawablePackages.reduce(
    (sum, p) =>
      sum +
      classesLeftToTeach({
        classesTotal: p.classesTotal,
        classesUsed: p.classesUsed,
        scheduled: scheduledByPackage.get(p.id) ?? 0,
      }),
    0,
  );

  const studentZone = link.student.timezone ?? teacher.timezone;
  const nextClassMoment = nextBooking
    ? getDualZoneTime(
        nextBooking.scheduledStart,
        { tz: teacher.timezone, label: t("web.dualZone.yourTime") },
        { tz: studentZone, label: link.student.name },
        locale,
      )
    : null;
  const nextIsLive =
    nextBooking != null &&
    classProximity(nextBooking.scheduledStart, nextBooking.scheduledEnd, now).state === "live";

  const paidLabel =
    paidByCurrency.length === 0
      ? formatMinorUnits(0, currencyForTeacher(teacher))
      : paidByCurrency
          .map((row) => formatMinorUnits(row._sum.amountMinorUnits ?? 0, row.currency))
          .join(" · ");
  const paidCount = paidByCurrency.reduce((sum, row) => sum + row._count._all, 0);

  return (
    <PageShell width="wide">
      <BackLink href="/dashboard/students" label={t("web.dashboard.students.title")} />

      <StudentIdentity
        studentId={studentId}
        name={link.student.name}
        email={link.student.email}
        phone={link.student.phoneE164}
        levelLabel={link.level?.label ?? null}
        notLive={link.onboardingHoldAt != null}
        archived={link.archivedAt != null}
        studentTimezone={link.student.timezone}
        teacherTimezone={teacher.timezone}
        locale={locale}
        now={now}
        t={t}
      />

      <StudentGlance
        classesLeft={classesLeft}
        activePackageCount={drawablePackages.length}
        nextClassLabel={
          nextIsLive
            ? t("web.dashboard.classes.list.liveNow")
            : nextClassMoment
              ? nextClassMoment.viewer.dateLabel
              : t("web.dashboard.students.glance.nothingBooked")
        }
        nextClassHint={
          nextClassMoment && !nextIsLive ? nextClassMoment.viewer.timeLabel : undefined
        }
        classesTaught={taughtCount}
        classesTaughtHint={
          packages.length > 0
            ? t("web.dashboard.students.glance.packagesBought", {
                count: String(packages.length),
              })
            : undefined
        }
        paidLabel={paidLabel}
        paidHint={
          paidCount > 0
            ? t("web.dashboard.students.glance.paymentsCount", { count: String(paidCount) })
            : undefined
        }
        t={t}
      />

      {/* Above the tabs, because it is about the student rather than about any
          one view of her, and because it is the one state in which every other
          control on the page behaves differently (nothing is sent to her). */}
      {link.onboardingHoldAt && (
        <Card className="border-info/30 bg-info-bg">
          <CardHeader>
            <CardTitle className="text-lg" as="h2">
              {t("web.dashboard.students.notLiveCard.title")}
            </CardTitle>
            <CardDescription>{t("web.dashboard.students.notLiveCard.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <GoLiveButton studentId={studentId} />
          </CardContent>
        </Card>
      )}

      <StudentTabNav studentId={studentId} active={tab} t={t} />

      {tab === "overview" && (
        <OverviewTab
          studentId={studentId}
          studentName={link.student.name}
          teacher={teacher}
          locale={locale}
          t={t}
          now={now}
          limit={OVERVIEW_CLASS_LIMIT}
          studentTimezone={studentZone}
          goals={link.goals}
          interests={link.interests}
          levelLabel={link.level?.label ?? null}
          liveBookingId={nextIsLive ? (nextBooking?.id ?? null) : null}
        />
      )}

      {tab === "packages" && (
        <PackagesTab
          studentId={studentId}
          teacher={teacher}
          locale={locale}
          t={t}
          packages={packages}
          scheduledByPackage={scheduledByPackage}
        />
      )}

      {tab === "learning" && (
        <LearningTab studentId={studentId} teacher={teacher} t={t} link={link} />
      )}

      {tab === "materials" && (
        <MaterialsTab
          studentId={studentId}
          teacher={teacher}
          locale={locale}
          t={t}
          filter={materialsFilter}
          groupBy={materialsGroupBy}
        />
      )}

      {tab === "settings" && (
        <SettingsTab studentId={studentId} teacher={teacher} t={t} link={link} />
      )}
    </PageShell>
  );
}
