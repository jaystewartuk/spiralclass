import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatBothZones } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { studentIdentityIds } from "@/lib/students/identity";
import { ClassContentMarkdown } from "@/components/class-content/class-content-markdown";
import { PrintButton } from "@/components/class-content/print-button";
import { getStudentClassContent } from "@/lib/materials/class-content";

// Print-optimized class-content view (D-17 PDF export fallback). A clean,
// chrome-light page that renders only the lesson content, so the browser's
// print-to-PDF produces a tidy hand-out. PDF stays a downstream export of the
// native content, never the canonical store.

export default async function ClassContentPrintPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = await params;
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const t = await getT();

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, studentId: { in: await studentIdentityIds(student) } },
    select: {
      id: true,
      scheduledStart: true,
      teacher: { select: { name: true, timezone: true } },
    },
  });
  if (!booking) notFound();
  // D-69: the booking-scoped "content" material — a body-bearing
  // LibraryMaterial with sendTiming null, always visible (no send-time gate).
  // The STUDENT copy: the resolver cuts the answer key before it gets here,
  // which matters doubly on this route because it is the printable view.
  const content = await getStudentClassContent(booking.id);
  // `!content.body`, not just `!content`: this route renders nothing but the
  // body (no file/link affordances), so a material that was entirely an answer
  // key has nothing to print — a 404 beats a blank sheet.
  if (!content?.body) notFound();

  return (
    <main className="container space-y-6 py-10 lg:max-w-2xl print:py-0">
      <div className="flex items-center justify-between print:hidden">
        <Link href={`/my-classes/${bookingId}`} className="text-sm underline">
          {t("web.myClasses.backToClass")}
        </Link>
        <PrintButton />
      </div>

      <header className="space-y-1">
        <Heading level={2} as="h1">
          {t("web.myClasses.content.title")}
        </Heading>
        <p className="text-sm text-muted-foreground">
          {t("web.myClasses.withTeacher")}
          {booking.teacher.name} ·{" "}
          {formatBothZones(
            booking.scheduledStart,
            booking.teacher.timezone,
            student.timezone,
            locale,
          )}
        </p>
      </header>

      <article>
        <ClassContentMarkdown body={content.body} readingWidth />
      </article>
    </main>
  );
}
