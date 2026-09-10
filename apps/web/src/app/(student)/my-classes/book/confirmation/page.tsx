import Link from "next/link";
import { notFound } from "next/navigation";
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
import { bookingWhen } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { studentIdentityIds } from "@/lib/students/identity";
import { buildBookingCalendarLinks } from "@/lib/calendar/add-to-calendar";
import { AddToCalendar } from "@/components/calendar/add-to-calendar";

export default async function ConfirmacionPage({
  searchParams,
}: {
  searchParams: Promise<{ bookingId?: string }>;
}) {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const t = await getT();
  const termsHref = en ? "/terms?lang=en#cancelaciones" : "/terms#cancelaciones";
  const { bookingId } = await searchParams;
  if (!bookingId) notFound();

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, studentId: { in: await studentIdentityIds(student) } },
    include: { teacher: { select: { name: true, timezone: true } } },
  });
  if (!booking) notFound();

  const studentTz =
    student.timezone ??
    // Fall back to the teacher's zone if we haven't captured the student's.
    booking.teacher.timezone;
  // Dual-timezone display standard: this student viewer's own local time is
  // primary, the teacher's is secondary — always both, even when the two
  // zones match.
  const when = bookingWhen(
    booking.scheduledStart,
    studentTz,
    { tz: booking.teacher.timezone, label: booking.teacher.name },
    locale,
    t,
  );

  const calendar = buildBookingCalendarLinks({
    uid: `booking-${booking.id}@spiralclass.com`,
    booking: {
      start: booking.scheduledStart,
      end: booking.scheduledEnd,
      title: t("web.myClasses.confirmation.calendarTitle", { name: booking.teacher.name }),
    },
  });

  return (
    <main className="container py-10 lg:max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>{t("web.myClasses.confirmation.title")}</CardTitle>
          <CardDescription>
            {t("web.myClasses.confirmation.subtitle", { name: booking.teacher.name })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <strong>{when.when}</strong>{" "}
            <span className="text-muted-foreground">({t("web.dualZone.yourTime")})</span>
          </p>
          <p className="text-muted-foreground">{when.whenSecondary}</p>
          <div className="pt-2">
            <p className="text-muted-foreground mb-2 text-xs font-medium">
              {t("web.myClasses.confirmation.addToCalendar")}
            </p>
            <AddToCalendar googleUrl={calendar.googleUrl} icsContent={calendar.ics} />
          </div>
          <p className="text-muted-foreground pt-2 text-xs">
            {t("book.confirm.cancellationNote")}{" "}
            <Link href={termsHref} className="underline">
              {t("terms.linkLabel")}
            </Link>
            .
          </p>
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button asChild>
            <Link href="/my-classes">{t("book.confirm.viewMine")}</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/my-classes/book">{t("book.confirm.bookAnother")}</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
