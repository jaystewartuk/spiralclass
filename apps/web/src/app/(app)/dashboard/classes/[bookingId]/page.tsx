import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { requireOnboardedTeacher } from "@/lib/auth";
import { isImageFileName } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatZonedDateTime, bookingWhen } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { cancelBookingAsTeacher } from "@/app/actions/cancel-booking";
import {
  markBookingNoShow,
  restoreClass,
  updateBookingLanguageOverrideAction,
  waiveCancellation,
} from "@/app/actions/overrides";
import { hasAnthropicCreds } from "@/lib/env";
import { liveCaptionsEnabled } from "@/lib/captions/config";
import { ClassLanguageFields } from "./class-language-fields";
import { overrideActionLabel } from "@/lib/overrides/labels";
import { getTeacherFocusGroups } from "@/lib/focus-tags";
import { getTeacherLevels, libraryBrowseWhere } from "@/lib/levels";
import { getClassContentForBooking } from "@/lib/materials/handlers";
import { OverrideAction } from "./override-action";
import { ManageClassMenu } from "./manage-class-menu";
import { MaterialsPanel } from "./materials-panel";
import { AtLevelMaterialsCard } from "./at-level-materials-card";
import { HomeworkPanel } from "./homework-panel";
import { LessonNotesPanel } from "./lesson-notes-panel";
import { LessonSummaryCard } from "./lesson-summary-card";
import { FocusAreasCard } from "./focus-areas-card";
import { SpeakingTimeCard } from "./speaking-time-card";
import { computeSpeakingTime } from "@/lib/lesson-notes/speaking-time";
import type { SpeakerUtterance } from "@/lib/transcription/types";
import { PrepareCard } from "./prepare-card";
import { getOrGenerateBrief } from "@/lib/lesson-notes/brief-service";
import { generateBrief } from "@/lib/lesson-notes/brief";
import { getStorageProvider } from "@/lib/storage/provider";
import { CallCta } from "@/components/call-cta";
import type { MaterialTag } from "@spiralclass/shared";

// Pull a material's non-archived tags into the wire shape the panel groups by.
function panelTagsOf(
  fts: { focusTag: { id: string; label: string; categoryId: string; archived: boolean } }[],
): MaterialTag[] {
  return fts
    .filter((ft) => !ft.focusTag.archived)
    .map((ft) => ({
      id: ft.focusTag.id,
      label: ft.focusTag.label,
      categoryId: ft.focusTag.categoryId,
    }));
}
import { pickMaterialsUrl } from "@/lib/storage/signed-urls";
import { buildBookingCalendarLinks } from "@/lib/calendar/add-to-calendar";
import { AddToCalendar } from "@/components/calendar/add-to-calendar";

// Upper bound on the "attach from library" picker (#778). The query was
// unbounded, so a teacher with a large library paid for every row on every
// class open.
const LIBRARY_PICKER_LIMIT = 500;

// Class detail — single source for one-tap overrides + the
// teacher-cancel path. The available action set depends on the
// booking's current status; we render only the actions that make sense.

export default async function TeacherClassDetailPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = await params;
  const teacher = await requireOnboardedTeacher();
  const [locale, t] = await Promise.all([getPreferredLocale(), getT()]);

  // Focus-tag picker for AI compose (D-19, Layer 2). Only loaded when AI is
  // configured; getTeacherFocusTags self-seeds the teacher's language pack on
  // first read. Grouped by category for the picker, in a stable order.
  const aiEnabled = hasAnthropicCreds();

  // First wave — every query here keys off the `bookingId` route param and/or
  // the authenticated teacher's own id, both known on entry. They used to sit
  // in five separate awaits chained behind the booking query, each paying a
  // full round trip (BEGIN + query + COMMIT + DEALLOCATE ALL) to wait for ids
  // it already had — the waterfall #778 removed. The booking query still
  // carries the ownership predicate, so
  // another teacher's booking still misses and 404s below — the siblings are
  // simply discarded unread in that case.
  const [booking, assignmentRows, focusGroups, content, libraryOptionsForPanel, overrides] =
    await Promise.all([
      prisma.booking.findFirst({
        where: { id: bookingId, teacherId: teacher.id },
        // Eleven relations, several of them nested. By default each is its
        // own round trip inside the transaction; "join" collapses them into
        // one LATERAL-join query (see the schema's generator block).
        relationLoadStrategy: "join",
        include: {
          student: {
            select: { id: true, name: true, email: true, nativeLanguage: true, timezone: true },
          },
          package: {
            select: {
              id: true,
              classesTotal: true,
              classesUsed: true,
              expiresAt: true,
              status: true,
              template: { select: { name: true } },
            },
          },
          rescheduleOf: {
            select: { id: true, scheduledStart: true },
          },
          reschedules: {
            select: { id: true, scheduledStart: true, status: true },
            orderBy: { scheduledStart: "asc" },
          },
          // Booking-scoped file/link materials (D-69 merge of the old
          // class_materials table) — every attachment has no body, whether it's
          // sent on a schedule or always visible (sendTiming null); the "content"
          // material (body set, sendTiming always null) is fetched separately
          // below, so filtering on body excludes it here.
          materials: {
            where: { body: null },
            select: {
              id: true,
              label: true,
              linkUrl: true,
              storagePath: true,
              sendTiming: true,
              createdAt: true,
              focusTags: {
                select: {
                  focusTag: { select: { id: true, label: true, categoryId: true, archived: true } },
                },
              },
            },
            orderBy: { createdAt: "desc" },
          },
          // Gap G3 — items attached from the reusable library instead of freshly
          // uploaded here.
          libraryMaterials: {
            select: {
              libraryMaterialId: true,
              sendTiming: true,
              material: {
                select: {
                  label: true,
                  storagePath: true,
                  linkUrl: true,
                  body: true,
                  focusTags: {
                    select: {
                      focusTag: {
                        select: { id: true, label: true, categoryId: true, archived: true },
                      },
                    },
                  },
                },
              },
            },
            orderBy: { attachedAt: "desc" },
          },
          // Bookmarks (D-97) are excluded here — they're not authoring/cue content;
          // they're surfaced as jump points on the replay view instead.
          lessonNotes: {
            where: { kind: "text" },
            select: { id: true, audience: true, body: true, position: true, doneAt: true },
            orderBy: { position: "asc" },
          },
          lessonSummary: { select: { body: true, createdAt: true } },
          // Focus areas (Phase C generates, Phase E validates). Dismissed rows are
          // hidden; ordered by category then time so the card groups cleanly. The
          // source/confirmedAt/skill fields drive the Phase E review controls.
          lessonInsights: {
            where: { dismissedAt: null },
            select: {
              id: true,
              category: true,
              summary: true,
              evidence: true,
              suggestion: true,
              atMs: true,
              source: true,
              confirmedAt: true,
              skill: true,
            },
            orderBy: [{ category: "asc" }, { atMs: "asc" }],
          },
          // Replay entry point (below) only shows a link when there's actually
          // something to replay — a completed recording or a transcript. Kept
          // minimal (no storageKey/utterances) since the replay page itself
          // fetches those; this is purely an existence check.
          callRecordings: {
            where: { status: "completed" },
            select: { id: true },
            take: 1,
          },
          lessonTranscript: { select: { bookingId: true, utterances: true } },
          // Speaking-time analytics (D-97) — LessonAudio.durationMs anchors the
          // lesson's total length; utterances above give per-speaker talk time.
          lessonAudio: { select: { durationMs: true } },
        },
      }),
      // The teacher's assignments list (docs/features/homework.md).
      prisma.assignment.findMany({
        where: { bookingId, teacherId: teacher.id },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { submissions: { where: { status: { not: "draft" } } } } },
        },
      }),
      aiEnabled
        ? getTeacherFocusGroups(teacher.id, teacher.targetLanguage, locale)
        : Promise.resolve([]),
      // The booking-scoped "content" material (D-69 merge) — a body-bearing
      // LibraryMaterial with sendTiming null, fetched separately from the
      // scheduled `materials` include above.
      getClassContentForBooking({ teacherId: teacher.id, bookingId }),
      // Picker source for "attach from library" — this teacher's active,
      // reusable items (bookingId null excludes another class's private
      // materials, D-69). Capped for the reason #778 gives: unbounded, a
      // large library paid for every row on every class open.
      prisma.libraryMaterial.findMany({
        where: { teacherId: teacher.id, archived: false, bookingId: null },
        select: { id: true, label: true, levelId: true, level: { select: { label: true } } },
        // Ladder order — groupMaterialsByLevel() groups in encounter order and
        // depends on this clause for it (see its doc comment).
        orderBy: [{ level: { position: "asc" } }, { position: "asc" }],
        take: LIBRARY_PICKER_LIMIT,
      }),
      prisma.override.findMany({
        where: {
          teacherId: teacher.id,
          targetType: "booking",
          targetId: bookingId,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
  if (!booking) notFound();

  const homeworkAssignments = assignmentRows.map((a) => ({
    id: a.id,
    title: a.title,
    dueAtLabel: a.dueAt ? formatZonedDateTime(a.dueAt, teacher.timezone, locale) : null,
    submissionCount: a._count.submissions,
  }));

  const hasReplay = booking.callRecordings.length > 0 || booking.lessonTranscript != null;
  const speakingTime = computeSpeakingTime(
    booking.lessonAudio,
    (booking.lessonTranscript?.utterances as unknown as SpeakerUtterance[] | undefined) ?? [],
  );

  const lessonNoteRows = booking.lessonNotes.map((n) => ({
    id: n.id,
    audience: n.audience,
    body: n.body,
    position: n.position,
    done: n.doneAt != null,
  }));
  const teacherNotes = lessonNoteRows.filter((n) => n.audience === "teacher");
  const studentNotes = lessonNoteRows.filter((n) => n.audience === "student");

  // Levels/templates/revisions/podcast eligibility are only needed by the
  // heavy MaterialForm editor, which now lives on its own page
  // (content/edit/page.tsx) — this page only needs the read-only preview
  // (content) plus focusGroups for the attached-materials category grouping,
  // both fetched in the first wave above.

  // Class-materials upload and tenant isolation: the bucket is private since Slice 7a part B, so the
  // teacher's panel can't link directly at the public URL anymore. Mint a
  // signed URL per row (cheap; bounded by the small number of materials
  // per class) and pass it down to the client component.
  const storage = getStorageProvider();
  // A content material can also carry a file/link on the same row (unified
  // material) — mint a signed URL so the panel can surface it back to the teacher.
  // Second wave — everything that genuinely needs the booking row, which the
  // first wave could not have. The teacher/student link is read ONCE here:
  // the archived-notification flag and the level that drives the Gap G4 shelf
  // were previously two separate queries against the very same row.
  const [contentFileUrl, materialsForPanel, attachedLibraryForPanel, studentLink, teacherLevels] =
    await Promise.all([
      // A content material can also carry a file/link on the same row (unified
      // material) — mint a signed URL so the panel can surface it back to the teacher.
      content?.storagePath
        ? pickMaterialsUrl(storage, { storagePath: content.storagePath, linkUrl: null })
        : null,
      Promise.all(
        booking.materials.map(async (m) => ({
          id: m.id,
          label: m.label,
          sendTiming: m.sendTiming,
          attachmentKind: (m.storagePath ? "file" : "link") as "file" | "link",
          isImage: isImageFileName(m.storagePath),
          viewUrl: await pickMaterialsUrl(storage, {
            storagePath: m.storagePath,
            linkUrl: m.linkUrl,
          }),
          tags: panelTagsOf(m.focusTags),
        })),
      ),
      // Gap G3 — library items attached to this class. A native-content item (no
      // storagePath/linkUrl) has no signed URL; the panel links to its PDF export
      // instead (same as the library page).
      Promise.all(
        booking.libraryMaterials.map(async (a) => ({
          libraryMaterialId: a.libraryMaterialId,
          label: a.material.label,
          sendTiming: a.sendTiming,
          viewUrl: a.material.body
            ? `/api/materials/${a.libraryMaterialId}/pdf`
            : await pickMaterialsUrl(storage, {
                storagePath: a.material.storagePath,
                linkUrl: a.material.linkUrl,
              }),
          tags: panelTagsOf(a.material.focusTags),
          body: a.material.body,
        })),
      ),
      // Archived students don't receive lifecycle notifications (reminders,
      // cancellations, materials) — that suppression is silent in the
      // pipeline, so surface it here where the teacher acts on the class.
      // levelId on the same row feeds the Gap G4 shelf below.
      prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: teacher.id, studentId: booking.student.id } },
        select: { archivedAt: true, levelId: true },
      }),
      teacher.autoSurfaceLevelMaterials ? getTeacherLevels(teacher.id) : Promise.resolve([]),
    ]);
  const studentArchived = studentLink?.archivedAt != null;

  // Gap G4 — opt-in auto-surface of level-matched materials, read-only.
  const atLevelMaterials = teacher.autoSurfaceLevelMaterials
    ? await (async () => {
        const attachedIds = new Set(booking.libraryMaterials.map((a) => a.libraryMaterialId));
        const rows = await prisma.libraryMaterial.findMany({
          where: libraryBrowseWhere(teacher.id, teacherLevels, studentLink?.levelId),
          select: { id: true, label: true },
          orderBy: { position: "asc" },
          take: 10,
        });
        return rows.filter((r) => !attachedIds.has(r.id));
      })()
    : [];

  const now = new Date();
  const isPastStart = booking.scheduledStart < now;
  const status = booking.status;

  // Phase F: the pre-class brief, built on-demand from the student's learning
  // profile when the teacher opens an UPCOMING class. Null unless AI is
  // configured and the student has a profile (so only Pro lessons reach it).
  const brief =
    aiEnabled && status === "scheduled" && !isPastStart
      ? await getOrGenerateBrief({ prisma, generate: generateBrief }, booking.id)
      : null;
  // Past classes auto-complete at their end time; a no-show is a relabel of a
  // class that's already scheduled-and-started or completed (quota-neutral).
  const canRecordNoShow = (status === "scheduled" && isPastStart) || status === "completed";

  // One-tap rebook, teacher side — mirrors the student booking detail's
  // `rebookable` view: once a class is completed
  // and the package still has classes left and isn't expired/refunded, surface
  // a "book another class" CTA into the teacher's own booking flow for this
  // student. The book flow handles slot availability from there.
  const rebookable =
    status === "completed" &&
    booking.package.status === "active" &&
    booking.package.classesUsed < booking.package.classesTotal &&
    (!booking.package.expiresAt || booking.package.expiresAt > now);

  const calendar =
    status === "scheduled" && !isPastStart
      ? buildBookingCalendarLinks({
          uid: `booking-${booking.id}@spiralclass.com`,
          booking: {
            start: booking.scheduledStart,
            end: booking.scheduledEnd,
            title: t("web.dashboard.classes.calendarEventTitle", { name: booking.student.name }),
          },
        })
      : null;

  // Same conditions each OverrideAction below is individually gated on — the
  // "Manage class" trigger only renders when at least one override is
  // actually available for this booking's status (brief: "The menu trigger
  // must be present whenever at least one override is available"). Note
  // `canRecordNoShow` is already true whenever `status === "completed"`, so
  // the return-to-package precondition (completed || no_show) is already
  // covered without repeating that check here.
  const canManageClass =
    canRecordNoShow ||
    status === "scheduled" ||
    status === "canceled_by_student" ||
    status === "no_show" ||
    liveCaptionsEnabled();

  // Dual-timezone display standard: this teacher viewer's own local time is
  // primary, the student's (falling back to the teacher's when unset) is
  // secondary — always both, even when the two zones match.
  const classWhen = bookingWhen(
    booking.scheduledStart,
    teacher.timezone,
    { tz: booking.student.timezone ?? teacher.timezone, label: booking.student.name },
    locale,
    t,
  );

  return (
    <PageShell width="default">
      <BackLink href="/dashboard/classes" label={t("nav.classes")} />
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Heading level={2} as="h1" className="truncate">
            {booking.student.name}
          </Heading>
          <p className="text-sm text-muted-foreground">
            {classWhen.when} · <BookingStatusLabel status={status} t={t} />
          </p>
          <p className="text-xs text-muted-foreground">{classWhen.whenSecondary}</p>
        </div>
        {canManageClass && (
          <ManageClassMenu>
            {canRecordNoShow && (
              <p className="text-sm text-muted-foreground">
                {t("web.dashboard.classes.detail.noShowHelp")}
              </p>
            )}
            {canRecordNoShow && (
              <OverrideAction
                action={markBookingNoShow}
                triggerLabel={t("web.dashboard.classes.detail.recordNoShow")}
                confirmLabel={t("web.dashboard.classes.detail.recordNoShow")}
                description={t("web.dashboard.classes.detail.recordNoShowDescription")}
                variant="destructive"
                hiddenInputs={{ bookingId: booking.id }}
                reasonLabel={t("web.dashboard.classes.override.internalNoteLabel")}
                reasonPlaceholder={t("web.dashboard.classes.detail.recordNoShowPlaceholder")}
              />
            )}
            {status === "scheduled" && (
              // A move, not a cancellation. It is a link rather than an
              // OverrideAction because choosing the new time needs the slot
              // picker — the audit row and the student's notification are
              // written by the action behind it, exactly like the others here.
              <Button asChild variant="outline">
                <Link href={`/dashboard/classes/${booking.id}/reschedule`}>
                  {t("web.dashboard.classes.detail.changeDateTime")}
                </Link>
              </Button>
            )}
            {status === "scheduled" && (
              <OverrideAction
                action={cancelBookingAsTeacher}
                triggerLabel={t("web.dashboard.classes.detail.cancelClass")}
                confirmLabel={t("web.dashboard.classes.detail.cancelAndRestore")}
                description={t("web.dashboard.classes.detail.cancelClassDescription")}
                variant="destructive"
                hiddenInputs={{ bookingId: booking.id }}
                reasonPlaceholder={t("web.dashboard.classes.detail.cancelClassPlaceholder")}
              />
            )}
            {(status === "canceled_by_student" || status === "no_show") && (
              <OverrideAction
                action={restoreClass}
                triggerLabel={t("web.dashboard.classes.detail.restoreClass")}
                confirmLabel={t("web.dashboard.classes.detail.restore")}
                description={t("web.dashboard.classes.detail.restoreClassDescription")}
                hiddenInputs={{ bookingId: booking.id }}
                reasonPlaceholder={t("web.dashboard.classes.detail.restoreClassPlaceholder")}
              />
            )}
            {(status === "completed" || status === "no_show") && (
              <OverrideAction
                action={cancelBookingAsTeacher}
                triggerLabel={t("web.dashboard.classes.detail.returnToPackage")}
                confirmLabel={t("web.dashboard.classes.detail.returnToPackageConfirm")}
                description={t("web.dashboard.classes.detail.returnToPackageDescription")}
                hiddenInputs={{ bookingId: booking.id }}
                reasonLabel={t("web.dashboard.classes.override.internalNoteLabel")}
                reasonPlaceholder={t("web.dashboard.classes.detail.returnToPackagePlaceholder")}
              />
            )}
            {status === "canceled_by_student" && (
              <OverrideAction
                action={waiveCancellation}
                triggerLabel={t("web.dashboard.classes.detail.waiveCancellation")}
                confirmLabel={t("web.dashboard.classes.detail.waive")}
                description={t("web.dashboard.classes.detail.waiveCancellationDescription")}
                hiddenInputs={{ bookingId: booking.id }}
                reasonPlaceholder={t("web.dashboard.classes.detail.waiveCancellationPlaceholder")}
              />
            )}
            {/* Extending the package's expiration is package-scoped, not
                class-scoped — it lives on the student's package section
                (Edit package → Expires), where the teacher manages the package
                itself. It was removed from here so the class page only carries
                class-scoped actions. */}
            {liveCaptionsEnabled() && (
              <OverrideAction
                action={updateBookingLanguageOverrideAction}
                triggerLabel={t("web.dashboard.classes.detail.language.trigger")}
                confirmLabel={t("common.save")}
                description={t("web.dashboard.classes.detail.language.description")}
                hiddenInputs={{ bookingId: booking.id }}
                reasonPlaceholder={t("web.dashboard.classes.detail.language.reasonPlaceholder")}
              >
                <ClassLanguageFields
                  currentTeacherLanguage={booking.teacherLanguageOverride}
                  currentStudentLanguage={booking.studentLanguageOverride}
                />
              </OverrideAction>
            )}
          </ManageClassMenu>
        )}
      </header>

      {studentArchived && (
        <div className="rounded-md border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning">
          <strong>
            {t("web.dashboard.classes.detail.archivedStrong", { name: booking.student.name })}
          </strong>{" "}
          {t("web.dashboard.classes.detail.archivedBody")}{" "}
          <Link href={`/dashboard/students/${booking.student.id}`} className="underline">
            {t("web.dashboard.classes.detail.archivedCta")}
          </Link>{" "}
          {t("web.dashboard.classes.detail.archivedSuffix")}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.dashboard.classes.detail.summary")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {calendar && (
            <div className="pb-1">
              <AddToCalendar googleUrl={calendar.googleUrl} icsContent={calendar.ics} />
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {t("web.dashboard.classes.detail.package")}
            </span>
            <span>
              {booking.package.template?.name ?? t("web.dashboard.classes.detail.package")} ·{" "}
              {t("web.dashboard.classes.detail.classesRemaining", {
                remaining: String(booking.package.classesTotal - booking.package.classesUsed),
                total: String(booking.package.classesTotal),
              })}
            </span>
          </div>
          {booking.rescheduleOf && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {t("web.dashboard.classes.detail.rescheduledFrom")}
              </span>
              <span>
                {formatZonedDateTime(booking.rescheduleOf.scheduledStart, teacher.timezone, locale)}
              </span>
            </div>
          )}
          {booking.reschedules.length > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {t("web.dashboard.classes.detail.rescheduledTo")}
              </span>
              <span>
                {formatZonedDateTime(
                  booking.reschedules[0].scheduledStart,
                  teacher.timezone,
                  locale,
                )}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Join the call — the primary in-class action, so it leads right after
          the summary, styled as the primary CTA rather than a plain card. The
          Pro/provider gate lives on the call page itself, so a Free teacher
          still sees the entry point here and gets the upgrade nudge there
          (same rationale as the old lesson-notes-panel entry point). */}
      {status === "scheduled" && (
        <CallCta
          href={`/dashboard/classes/${booking.id}/call`}
          title={t("call.title")}
          subtitle={t("call.teacherHelp")}
          cta={t("call.join")}
        />
      )}

      {rebookable && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-lg">
              {t("web.dashboard.classes.detail.rebookTitle")}
            </CardTitle>
            <CardDescription>
              {t("web.dashboard.classes.detail.rebookDescription", {
                name: booking.student.name,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={`/dashboard/classes/book?studentId=${booking.student.id}`}>
                {t("web.dashboard.classes.detail.rebookCta")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {brief && <PrepareCard bookingId={booking.id} brief={brief.brief} />}

      {/* Materials sit high up — attaching or authoring class content is one of
          the most frequent things a teacher does on this screen. */}
      <MaterialsPanel
        bookingId={booking.id}
        content={content ?? undefined}
        contentFileUrl={contentFileUrl}
        contentLinkUrl={content?.linkUrl ?? null}
        materials={materialsForPanel}
        libraryOptions={libraryOptionsForPanel.map((m) => ({
          id: m.id,
          label: m.label ?? "",
          // Reusable items (bookingId null, filtered above) always have a
          // level in practice; the relation is nullable in the schema only
          // to accommodate booking-scoped rows.
          levelId: m.levelId,
          levelLabel: m.level?.label ?? "",
        }))}
        attachedLibrary={attachedLibraryForPanel}
        // Category order for grouping the attached list — derived from the
        // teacher's own category order (focusGroups is already position-sorted).
        categories={focusGroups.map((g, i) => ({
          id: g.categoryId,
          label: g.categoryLabel,
          position: i,
        }))}
      />

      {/* Homework management sits right after materials — the two most
          frequent between-class teacher tasks — ahead of notes/history. */}
      <HomeworkPanel bookingId={booking.id} assignments={homeworkAssignments} />

      <LessonNotesPanel
        bookingId={booking.id}
        teacherNotes={teacherNotes}
        studentNotes={studentNotes}
      />

      {isPastStart && (
        <LessonSummaryCard
          bookingId={booking.id}
          summary={
            booking.lessonSummary
              ? {
                  body: booking.lessonSummary.body,
                  generatedAt: formatZonedDateTime(
                    booking.lessonSummary.createdAt,
                    teacher.timezone,
                    locale,
                  ),
                }
              : null
          }
          hasNotes={lessonNoteRows.length > 0}
        />
      )}

      {isPastStart && (
        <FocusAreasCard
          bookingId={booking.id}
          insights={booking.lessonInsights.map((i) => ({
            id: i.id,
            category: i.category,
            summary: i.summary,
            evidence: i.evidence,
            suggestion: i.suggestion,
            atMs: i.atMs,
            source: i.source,
            confirmed: i.confirmedAt != null,
            skill: i.skill,
          }))}
        />
      )}

      {isPastStart && speakingTime && <SpeakingTimeCard summary={speakingTime} t={t} />}

      {isPastStart && hasReplay && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.dashboard.classes.replay.cardTitle")}</CardTitle>
            <CardDescription>{t("web.dashboard.classes.replay.cardHelp")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="secondary">
              <Link href={`/dashboard/classes/${booking.id}/replay`}>
                {t("web.dashboard.classes.replay.cardCta")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {atLevelMaterials.length > 0 && (
        <AtLevelMaterialsCard bookingId={booking.id} materials={atLevelMaterials} />
      )}

      {overrides.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {t("web.dashboard.classes.detail.adjustmentHistory")}
            </CardTitle>
            <CardDescription>
              {t("web.dashboard.classes.detail.adjustmentHistoryHelp")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {overrides.map((o) => (
              <div key={o.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{overrideActionLabel(o.action, t)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatZonedDateTime(o.createdAt, teacher.timezone, locale)}
                  </span>
                </div>
                <p className="text-muted-foreground">{o.reason}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}

function BookingStatusLabel({ status, t }: { status: string; t: TFunction }) {
  const map: Record<string, string> = {
    scheduled: t("booking.status.scheduled"),
    completed: t("booking.status.completed"),
    canceled_by_student: t("web.dashboard.classes.detail.status.canceledByStudent"),
    canceled_by_teacher: t("web.dashboard.classes.detail.status.canceledByTeacher"),
    rescheduled: t("booking.status.rescheduled"),
    no_show: t("booking.status.no_show"),
  };
  return <span>{map[status] ?? status}</span>;
}
