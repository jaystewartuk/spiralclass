import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatZonedDateTime } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { ClassContentMarkdown } from "@/components/class-content/class-content-markdown";
import { PrintButton } from "@/components/class-content/print-button";
import { getClassContentForBooking } from "@/lib/materials/handlers";

// Teacher-side print-optimized class-content view (D-17 PDF export). Mirrors the
// student print page so Alicia Moreno can save/hand out a tidy PDF of the lesson she
// authored. Chrome-light: `print:` utilities hide the nav so the browser's
// print-to-PDF yields a clean hand-out. PDF stays a downstream export of the
// native Markdown, never the canonical store.

export default async function TeacherClassContentPrintPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = await params;
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId: teacher.id },
    select: {
      scheduledStart: true,
      student: { select: { name: true } },
    },
  });
  if (!booking) notFound();
  const content = await getClassContentForBooking({ teacherId: teacher.id, bookingId });
  if (!content) notFound();

  return (
    <main className="container space-y-6 py-10 lg:max-w-2xl print:py-0">
      <div className="flex items-center justify-between print:hidden">
        <Link href={`/dashboard/classes/${bookingId}`} className="text-sm underline">
          {`← ${t("present.back")}`}
        </Link>
        <PrintButton />
      </div>

      <header className="space-y-1">
        <Heading level={2} as="h1">
          {t("classContent.title")}
        </Heading>
        <p className="text-muted-foreground text-sm">
          {booking.student.name} ·{" "}
          {formatZonedDateTime(booking.scheduledStart, teacher.timezone, locale)}
        </p>
      </header>

      <article>
        <ClassContentMarkdown body={content.body} readingWidth />
      </article>
    </main>
  );
}
