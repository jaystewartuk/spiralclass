import { notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { BackLink } from "@/components/back-link";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { hasAnthropicCreds, podcastsEnabled } from "@/lib/env";
import { getTeacherLevels } from "@/lib/levels";
import { getTeacherFocusGroups } from "@/lib/focus-tags";
import {
  getClassContentForBooking,
  listClassContentRevisionsForBooking,
  listContinuationCandidatesForBooking,
} from "@/lib/materials/handlers";
import { listClassContentTemplates } from "@/lib/materials/templates";
import { MaterialForm } from "@/components/materials/material-form";
import { loadEntitlements } from "@/lib/subscriptions/service";

// Dedicated surface for the heavy class-content editor (class-detail redesign
// brief, docs/features/classes-lesson-content.md): the `multiline`
// MaterialForm "write" editor used to render inline on the class-detail page,
// where it dominated the scroll and trapped drag gestures above the
// lifecycle-override actions. It now owns its own page — nothing below it to
// scroll to — reached from the "Edit content" link on the detail page's
// materials panel. Reuses the exact same handlers/queries the detail page
// used to feed MaterialForm.
export default async function TeacherClassContentEditPage({
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
    select: { id: true, student: { select: { name: true } } },
  });
  if (!booking) notFound();

  const aiEnabled = hasAnthropicCreds();
  const podcastEnabled = aiEnabled && podcastsEnabled();
  const isPro = (await loadEntitlements(teacher.id)).isPro;
  const [focusGroups, levels, templates, revisions, content, continuationCandidates] =
    await Promise.all([
      aiEnabled
        ? getTeacherFocusGroups(teacher.id, teacher.targetLanguage, locale)
        : Promise.resolve([]),
      // Levels for the "save to library" picker on the content panel.
      getTeacherLevels(teacher.id),
      // Reusable lesson skeletons for "start from template".
      listClassContentTemplates(teacher.id),
      // Recent version history for "restore previous version".
      listClassContentRevisionsForBooking({ teacherId: teacher.id, bookingId: booking.id }),
      // The booking-scoped "content" material (D-69 merge) — a body-bearing
      // LibraryMaterial with sendTiming null.
      getClassContentForBooking({ teacherId: teacher.id, bookingId: booking.id }),
      // Lesson continuity: this student's other classes with body-bearing
      // content, offered as "continue from" context for a fresh generation.
      listContinuationCandidatesForBooking({ teacherId: teacher.id, bookingId: booking.id }),
    ]);

  return (
    <PageShell width="default">
      <BackLink href={`/dashboard/classes/${bookingId}`} label={booking.student.name} />

      <header className="space-y-1">
        <PageHeader title={t("web.dashboard.classes.detail.editContent")} />
      </header>

      <MaterialForm
        scope="booking"
        bookingId={booking.id}
        levels={levels.map((l) => ({ id: l.id, label: l.label }))}
        focusGroups={focusGroups}
        templates={templates}
        revisions={revisions ?? []}
        aiEnabled={aiEnabled}
        isPro={isPro}
        podcastEnabled={podcastEnabled}
        existing={content ?? undefined}
        continuationCandidates={continuationCandidates ?? []}
      />
    </PageShell>
  );
}
