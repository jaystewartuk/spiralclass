import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BookingCard } from "@/components/booking-card";
import { BookingStatusBadge, MaterialsBadge } from "@/components/booking-status-badge";
import { bookingWhen as sharedBookingWhen } from "@/lib/date-display";
import { groupBookingsByDay } from "@/lib/booking-day-groups";
import { getPreferredLocale, getT, type AppLocale } from "@/lib/i18n";
import { materialSendTimeElapsed } from "@/lib/materials/timing";
import { studentIdentityIds } from "@/lib/students/identity";
import { PackageDetailsSheet } from "@/components/packages/package-details-sheet";
import { ReferralShare } from "./referral-share";
import { ClassesViewToggle } from "./classes-view-toggle";

type OverrideSummary = {
  bookingId: string;
  action: string;
  reason: string;
};

type PackageSummary = {
  id: string;
  templateName: string | null;
  subject: string | null;
  classesTotal: number;
  classesUsed: number;
  expiresAt: Date | null;
  status: string;
  teacherName: string;
  teacherTimezone: string;
};

export default async function StudentPortalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const t = await getT();
  const params = await searchParams;
  // Set by requireTeacher() (lib/auth.ts) when this login already owns a
  // Student row and tried to also create a Teacher row — Teacher/Student
  // are mutually exclusive per auth identity, so explain why they landed
  // here instead of the dashboard rather than redirecting silently.
  const alreadyStudentNotice = params.notice === "already-student";
  // Everything the signed-in inbox owns, across teachers — the person's
  // rows under other teachers included (see studentIdentityIds).
  const studentIds = await studentIdentityIds(student);

  const packages = await prisma.package.findMany({
    where: { studentId: { in: studentIds } },
    orderBy: [{ status: "asc" }, { purchasedAt: "desc" }],
    include: {
      template: { select: { name: true, subject: true } },
      teacher: { select: { name: true, timezone: true } },
    },
  });

  // The student's level with each of their teachers (per-teacher, so a
  // multi-teacher student sees each). Shown near the greeting so their level is
  // visible on the first page they land on.
  const levelLinks = await prisma.teacherStudent.findMany({
    where: { studentId: { in: studentIds }, levelId: { not: null } },
    select: { level: { select: { label: true } }, teacher: { select: { name: true } } },
  });

  const bookings = await prisma.booking.findMany({
    where: { studentId: { in: studentIds } },
    orderBy: { scheduledStart: "asc" },
    include: {
      teacher: { select: { name: true, timezone: true } },
      package: { select: { classDurationMin: true, template: { select: { name: true } } } },
      // Every class-scoped/private material (D-69 merge) — a file/link
      // attachment OR native written content (body set) alike; both count
      // toward "has materials". A scheduled or always-visible attachment
      // qualifies once its send time has elapsed; materialSendTimeElapsed
      // below treats a null sendTiming (the always-visible content case) as
      // always-elapsed.
      materials: { select: { sendTiming: true } },
      // Gap G3 — items the teacher attached from her reusable library. These
      // are just as visible to the student as a fresh upload (the detail page
      // renders both), so the list badge must count them too, or attaching an
      // already-created material would never light the "has materials" badge.
      libraryMaterials: { select: { sendTiming: true } },
    },
  });

  // — surface teacher overrides on this student's bookings so the
  // student sees the reason in their history. Pulled in one query keyed
  // on the visible booking ids.
  const visibleBookingIds = bookings.map((b) => b.id);
  const overrideRows = visibleBookingIds.length
    ? await prisma.override.findMany({
        where: {
          targetType: "booking",
          targetId: { in: visibleBookingIds },
        },
        orderBy: { createdAt: "desc" },
        select: { targetId: true, action: true, reason: true },
      })
    : [];
  const overridesByBooking = new Map<string, OverrideSummary[]>();
  for (const o of overrideRows) {
    const list = overridesByBooking.get(o.targetId) ?? [];
    list.push({ bookingId: o.targetId, action: o.action, reason: o.reason });
    overridesByBooking.set(o.targetId, list);
  }

  const now = new Date();
  const upcoming = bookings.filter((b) => b.status === "scheduled" && b.scheduledStart > now);
  const past = bookings
    .filter((b) => b.status !== "scheduled" || b.scheduledStart <= now)
    .slice(-8)
    .reverse();

  // Class-material send timing — same "has the send time elapsed" gate the booking detail page
  // uses, so the classes list never teases materials that aren't visible
  // to the student yet.
  const hasVisibleMaterials = (b: (typeof bookings)[number]) =>
    b.materials.some((m) => materialSendTimeElapsed(m.sendTiming, b.scheduledStart, now)) ||
    b.libraryMaterials.some((a) => materialSendTimeElapsed(a.sendTiming, b.scheduledStart, now));
  const bookingMeta = (b: (typeof bookings)[number]) =>
    `${b.package.template?.name ?? t("book.choosePackage")} · ${b.package.classDurationMin} min`;

  const active = packages.filter((p) => p.status === "active");
  const bookable = active.filter(
    (p) => p.classesUsed < p.classesTotal && (!p.expiresAt || p.expiresAt > now),
  );
  const expiredOrFull = packages.filter((p) => !bookable.some((b) => b.id === p.id));

  const hasAnyBookable = bookable.length > 0;

  // The portal can only sell across an active pairing with a sellable
  // teacher (mirrors the /my-classes/buy eligibility query). Without
  // one, the buy CTAs make no sense — fall back to the "ask your teacher"
  // copy instead.
  const eligibleTeacherCount = await prisma.teacherStudent.count({
    where: {
      studentId: { in: studentIds },
      archivedAt: null,
      teacher: { onboardingCompleteAt: { not: null }, disabledAt: null },
    },
  });
  const canBuy = eligibleTeacherCount > 0;

  // Running-low banner: the student is at their highest purchase intent
  // when the last class is in sight (or the clock is about to eat the
  // package) — surface the repurchase path right there, not just in the
  // footer. Email nudges cover students who don't visit the portal.
  const SOON_MS = 7 * 24 * 60 * 60 * 1000;
  const remainingBookable = bookable.reduce((sum, p) => sum + (p.classesTotal - p.classesUsed), 0);
  const expiringSoon = bookable.some(
    (p) => p.expiresAt && p.expiresAt.getTime() - now.getTime() <= SOON_MS,
  );
  const showRunningLow = canBuy && hasAnyBookable && (remainingBookable <= 1 || expiringSoon);

  const greetingTeacher = packages[0]?.teacher.name ?? null;
  const studentTz = student.timezone;
  // There's no single "the"
  // timezone for a student who may have bookings across teachers in
  // different zones — the student's own zone (or the first upcoming
  // booking's teacher zone) stands in as the day-boundary reference.
  const dayGroupTz = studentTz ?? upcoming[0]?.teacher.timezone ?? "UTC";
  const upcomingGroups = groupBookingsByDay(upcoming, dayGroupTz, locale, now, t);

  const toSummary = (p: (typeof packages)[number]): PackageSummary => ({
    id: p.id,
    templateName: p.template?.name ?? null,
    subject: p.template?.subject ?? null,
    classesTotal: p.classesTotal,
    classesUsed: p.classesUsed,
    expiresAt: p.expiresAt,
    status: p.status,
    teacherName: p.teacher.name,
    teacherTimezone: p.teacher.timezone,
  });

  return (
    <PageShell width="default">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Heading level={2} as="h1">
              {t("student.portal.greeting", { name: student.name })}
            </Heading>
            {greetingTeacher && (
              <p className="text-muted-foreground text-sm">
                {t("buyAnother.with", { name: greetingTeacher })}
              </p>
            )}
            {levelLinks.length === 1 && levelLinks[0].level && (
              <p className="mt-1 text-sm font-medium">
                {t("library.yourLevel", { level: levelLinks[0].level.label })}
              </p>
            )}
            {levelLinks.length > 1 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {levelLinks.map(
                  (l, i) =>
                    l.level && (
                      <span
                        key={`${l.teacher.name}-${i}`}
                        className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs"
                      >
                        {`${l.teacher.name}: ${l.level.label}`}
                      </span>
                    ),
                )}
              </div>
            )}
          </div>
          {/* Product issue #3 — always-visible list/calendar switch, not just a
              button a student has to notice among the others. */}
          <ClassesViewToggle active="list" t={t} />
        </div>
        {hasAnyBookable && (
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/my-classes/book">{t("student.portal.bookCta")}</Link>
            </Button>
          </div>
        )}
      </header>

      {alreadyStudentNotice && (
        <div
          role="alert"
          className="border-warning/30 bg-warning-bg rounded-md border px-4 py-3 text-sm"
        >
          {t("web.studentHome.alreadyStudentNotice")}
        </div>
      )}

      {showRunningLow && (
        <div className="border-warning/30 bg-warning-bg flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3">
          <p className="text-sm">
            {remainingBookable <= 1
              ? t("web.studentHome.oneClassLeft")
              : t("web.studentHome.packageExpiresSoon")}
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href="/my-classes/buy">{t("web.studentHome.buyAnotherPackage")}</Link>
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("web.studentHome.myPackages")}</CardTitle>
          <CardDescription>{t("web.studentHome.myPackagesSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {packages.length === 0 && (
            <p className="text-muted-foreground text-sm">
              {canBuy
                ? t("web.studentHome.noActivePackage")
                : t("web.studentHome.noActivePackageAskTeacher")}
            </p>
          )}
          {bookable.map((p) => (
            <PackageRow key={p.id} pkg={toSummary(p)} highlight locale={locale} t={t} />
          ))}
          {expiredOrFull.map((p) => (
            <PackageRow key={p.id} pkg={toSummary(p)} locale={locale} t={t} />
          ))}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          {hasAnyBookable ? (
            canBuy && (
              <Button asChild variant="outline">
                <Link href="/my-classes/buy">{t("web.studentHome.buyAnotherPackage")}</Link>
              </Button>
            )
          ) : canBuy ? (
            // The old dead end. With no bookable package this is the
            // moment of highest purchase intent — point straight at the
            // in-portal repurchase flow.
            <Button asChild>
              <Link href="/my-classes/buy">{t("buyAnother.title")}</Link>
            </Button>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("web.studentHome.onceActiveBookHere")}
            </p>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("home.upcoming")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {upcoming.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("classes.empty.upcoming")}</p>
          ) : (
            upcomingGroups.map((group) => (
              <div key={group.ymd} className="space-y-2">
                <p className="text-muted-foreground text-sm">{group.label}</p>
                <div className="space-y-2">
                  {group.items.map((b) => (
                    <BookingCard
                      key={b.id}
                      href={`/my-classes/${b.id}`}
                      title={b.teacher.name}
                      {...bookingWhen(
                        b.scheduledStart,
                        b.teacher.timezone,
                        b.teacher.name,
                        studentTz,
                        locale,
                        t,
                      )}
                      meta={bookingMeta(b)}
                      status={<BookingStatusBadge status={b.status} viewer="student" />}
                      materials={
                        <MaterialsBadge hasMaterials={hasVisibleMaterials(b)} status={b.status} />
                      }
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {past.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("student.portal.history")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {past.map((b) => {
              const ovs = overridesByBooking.get(b.id) ?? [];
              return (
                <BookingCard
                  key={b.id}
                  href={`/my-classes/${b.id}`}
                  title={b.teacher.name}
                  {...bookingWhen(
                    b.scheduledStart,
                    b.teacher.timezone,
                    b.teacher.name,
                    studentTz,
                    locale,
                    t,
                  )}
                  meta={bookingMeta(b)}
                  status={<BookingStatusBadge status={b.status} viewer="student" />}
                  materials={
                    <MaterialsBadge hasMaterials={hasVisibleMaterials(b)} status={b.status} />
                  }
                >
                  {ovs.length > 0 && (
                    <ul className="mt-2 space-y-0.5 border-t pt-2">
                      {ovs.map((o, i) => (
                        <li key={`${b.id}-${i}`} className="text-muted-foreground text-xs">
                          <span className="font-medium">{studentOverrideLabel(o.action, t)}:</span>{" "}
                          {o.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </BookingCard>
              );
            })}
          </CardContent>
        </Card>
      )}

      <ReferralShare studentIds={studentIds} />
    </PageShell>
  );
}

function studentOverrideLabel(action: string, t: Awaited<ReturnType<typeof getT>>): string {
  switch (action) {
    case "teacher_book_class":
      return t("web.studentHome.override.bookedByTeacher");
    case "teacher_cancel":
      return t("web.studentHome.override.canceledByTeacher");
    case "mark_complete":
      return t("web.studentHome.override.confirmedByTeacher");
    case "mark_no_show":
      return t("web.studentHome.override.recordedNoShow");
    case "restore_class":
      return t("web.studentHome.override.restored");
    case "waive_cancellation":
      return t("web.studentHome.override.cancellationWaived");
    case "extend_expiration":
      return t("web.studentHome.override.expirationExtended");
    default:
      return action;
  }
}

function PackageRow({
  pkg,
  highlight = false,
  locale,
  t,
}: {
  pkg: PackageSummary;
  highlight?: boolean;
  locale: AppLocale;
  t: Awaited<ReturnType<typeof getT>>;
}) {
  const remaining = pkg.classesTotal - pkg.classesUsed;
  // Teacher name leads (the differentiator across teachers). The detail line
  // pairs the subject with the size label, e.g. "Conversación · 8 clases / 1 mes".
  const detail = [pkg.subject, pkg.teacherName ? pkg.templateName : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <PackageDetailsSheet packageId={pkg.id}>
      <div
        className={`flex items-center justify-between rounded-md border px-3 py-2 ${
          highlight ? "bg-muted/40" : "opacity-70"
        }`}
      >
        <div>
          <p className="font-medium">
            {pkg.teacherName ?? pkg.templateName ?? t("book.choosePackage")}
          </p>
          {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
          <p className="text-muted-foreground text-xs">
            {t("web.studentHome.classesOfTotal", {
              remaining,
              total: pkg.classesTotal,
            })}{" "}
            {pkg.expiresAt
              ? t("web.studentHome.expiresOn", {
                  date: formatShortDate(pkg.expiresAt, pkg.teacherTimezone, locale),
                })
              : ""}
          </p>
        </div>
        <span className="text-muted-foreground text-xs">{renderPackageStatus(pkg.status, t)}</span>
      </div>
    </PackageDetailsSheet>
  );
}

function renderPackageStatus(status: string, t: Awaited<ReturnType<typeof getT>>): string {
  switch (status) {
    case "active":
      return t("package.status.active");
    case "paused":
      return t("package.status.paused");
    case "expired":
      return t("package.status.expired");
    case "refunded":
      return t("package.status.refunded");
    default:
      return status;
  }
}

// Student-portal wiring for the shared bookingWhen: the student viewer's own
// zone (falling back to the teacher's when unset) is the viewer side, the
// teacher is always the "other" side.
function bookingWhen(
  scheduledStart: Date,
  teacherTz: string,
  teacherName: string,
  studentTz: string | null,
  locale: AppLocale,
  t: Awaited<ReturnType<typeof getT>>,
): { when: string; whenSecondary: string } {
  return sharedBookingWhen(
    scheduledStart,
    studentTz ?? teacherTz,
    { tz: teacherTz, label: teacherName },
    locale,
    t,
  );
}

function formatShortDate(d: Date, tz: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-MX", {
    timeZone: tz,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}
