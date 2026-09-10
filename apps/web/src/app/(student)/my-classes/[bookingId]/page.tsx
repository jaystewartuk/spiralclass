import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { notFound } from "next/navigation";
import { requireStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { bookingWhen } from "@/lib/date-display";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { canStudentRescheduleBooking, scheduleChangeBudget } from "@/lib/cancellation/classify";
import { materialSendTimeElapsed } from "@/lib/materials/timing";
import { libraryBrowseWhere, getTeacherLevels } from "@/lib/levels";
import { groupMaterialsByCategory, isImageFileName, type MaterialTag } from "@spiralclass/shared";
import { MaterialImagePreview } from "@/components/materials/material-image-preview";
import { lessonNoteStudentVisible } from "@/lib/lesson-notes/visibility";
import { gateProFeature } from "@/lib/subscriptions/enforce";
import { getVideoProvider } from "@/lib/video/provider";
import { getStorageProvider } from "@/lib/storage/provider";
import { pickMaterialsUrl } from "@/lib/storage/signed-urls";
import { studentIdentityIds } from "@/lib/students/identity";
import { buildBookingCalendarLinks } from "@/lib/calendar/add-to-calendar";
import { AddToCalendar } from "@/components/calendar/add-to-calendar";
import { ClassContentMarkdown } from "@/components/class-content/class-content-markdown";
import { BackLink } from "@/components/back-link";
import { TeacherNameLink } from "@/components/teacher-identity";
import { PackageDetailsSheet } from "@/components/packages/package-details-sheet";
import { CallCta } from "@/components/call-cta";
import { Collapsible } from "@/components/ui/collapsible";
import { HomeworkStatusBadge } from "@/components/homework-status-badge";
import { toWireAssignmentSummary } from "@/lib/homework/wire";
import { StudentLiveNotes } from "./student-live-notes";
import { StudentCancelForm } from "./cancel-form";
import { getStudentClassContent } from "@/lib/materials/class-content";

// Past this many attached materials, the list collapses to avoid pushing
// homework/notes below the fold — see the class-detail redesign audit.
const MATERIALS_COLLAPSE_THRESHOLD = 4;

// Student-facing booking detail. Cancel + (conditionally) reschedule entry
// points sit here. Override reasons from the teacher's actions show up in
// a footer section so the student understands changes (teacher overrides).

export default async function StudentBookingDetailPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = await params;
  const student = await requireStudent();
  const [locale, t, identityIds] = await Promise.all([
    getPreferredLocale(),
    getT(),
    studentIdentityIds(student),
  ]);

  // First wave — everything here keys off the `bookingId` route param, so
  // none of it needs the booking row to exist first. The class-content
  // material and the homework rows used to be chained behind the booking
  // query even though both scope on a booking id this function already had;
  // that is the same waterfall #778 removed from the teacher class page.
  // The booking query still carries the authorization predicate — if it
  // misses we notFound() below and the sibling results are discarded unread.
  const [booking, classContent, assignmentRows] = await Promise.all([
    prisma.booking.findFirst({
      where: { id: bookingId, studentId: { in: identityIds } },
      // Seven relations, several with a nested focusTags hop. By default each
      // is a separate round trip inside the transaction; "join" collapses
      // them into one LATERAL-join query (see the schema's generator block).
      relationLoadStrategy: "join",
      include: {
        teacher: {
          select: { id: true, name: true, timezone: true, autoSurfaceLevelMaterials: true },
        },
        package: {
          select: {
            id: true,
            classesTotal: true,
            classesUsed: true,
            scheduleChangesUsed: true,
            status: true,
            expiresAt: true,
            template: { select: { name: true } },
          },
        },
        rescheduleOf: { select: { id: true, scheduledStart: true } },
        reschedules: {
          select: { id: true, scheduledStart: true },
          orderBy: { scheduledStart: "asc" },
        },
        // Booking-scoped file/link attachments — scheduled or always-visible
        // (D-69 merge of the old class_materials table) — excludes the
        // "content" material (body set), fetched separately below.
        materials: {
          where: { body: null },
          select: {
            id: true,
            label: true,
            levelId: true,
            linkUrl: true,
            storagePath: true,
            sendTiming: true,
            focusTags: {
              select: {
                focusTag: { select: { id: true, label: true, categoryId: true, archived: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        // Gap G3 — items the teacher attached from her reusable library.
        libraryMaterials: {
          select: {
            libraryMaterialId: true,
            sendTiming: true,
            material: {
              select: {
                label: true,
                levelId: true,
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
        // D-15: only student-audience notes ever reach the student; teacher cues
        // are never selected here. Visibility is further gated to the class window
        // below.
        lessonNotes: {
          where: { audience: "student" },
          select: { id: true, body: true },
          orderBy: { position: "asc" },
        },
      },
    }),
    // D-17: native class content is always visible once present (no send-time
    // gate, unlike materials). The teacher authors it; the student reads it
    // here. The resolver serves the STUDENT copy — answer-key callouts cut —
    // which is why this is not the inline query it used to be.
    getStudentClassContent(bookingId),
    // The student homework view (docs/features/homework.md). This card is
    // the summary list + status badge; submitting and reading the teacher's
    // feedback live on the assignment page.
    prisma.assignment.findMany({
      where: { bookingId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        dueAt: true,
        submissions: {
          // Scoped to the same identity set that authorizes the booking above
          // rather than to booking.studentId: equivalent, because the booking
          // belongs to one of these identities, and known before it resolves.
          where: { studentId: { in: identityIds } },
          select: { status: true, submittedAt: true, _count: { select: { files: true } } },
          take: 1,
        },
      },
    }),
  ]);
  if (!booking) notFound();

  const homework = assignmentRows.map((a) =>
    toWireAssignmentSummary(
      a,
      a.submissions[0]
        ? {
            status: a.submissions[0].status,
            submittedAt: a.submissions[0].submittedAt,
            fileCount: a.submissions[0]._count.files,
          }
        : null,
    ),
  );

  const now = new Date();

  // Second wave — these genuinely need the booking row (teacherId/studentId),
  // so they cannot join the first. Overrides stay scoped by teacherId as well
  // as by target, and that id is only known once the booking resolves.
  // Teacher levels + tag categories + this student's level are fetched once
  // and reused for material grouping, the student's "your level" line, and
  // the auto-surface shelf below.
  const [classContentFileUrl, overrides, teacherLevels, teacherCategories, studentLink] =
    await Promise.all([
      // A content material can now also carry a file and/or link on the same
      // row (unified material) — surface them in the content card alongside
      // the body.
      classContent?.storagePath
        ? pickMaterialsUrl(getStorageProvider(), {
            storagePath: classContent.storagePath,
            linkUrl: null,
          })
        : null,
      prisma.override.findMany({
        where: {
          teacherId: booking.teacherId,
          targetType: "booking",
          targetId: booking.id,
        },
        orderBy: { createdAt: "desc" },
      }),
      getTeacherLevels(booking.teacherId),
      prisma.focusTagCategory.findMany({
        where: { teacherId: booking.teacherId, archived: false },
        select: { id: true, label: true, position: true },
        orderBy: { position: "asc" },
      }),
      prisma.teacherStudent.findUnique({
        where: {
          teacherId_studentId: { teacherId: booking.teacherId, studentId: booking.studentId },
        },
        select: { levelId: true, level: { select: { label: true } } },
      }),
    ]);
  const levelLabelById = new Map(teacherLevels.map((l) => [l.id, l.label]));
  const studentLevelLabel = studentLink?.level?.label ?? null;
  const tagsOf = (
    fts: { focusTag: { id: string; label: string; categoryId: string; archived: boolean } }[],
  ): MaterialTag[] =>
    fts
      .filter((ft) => !ft.focusTag.archived)
      .map((ft) => ({
        id: ft.focusTag.id,
        label: ft.focusTag.label,
        categoryId: ft.focusTag.categoryId,
      }));

  //: only materials whose send time has elapsed are visible. Sent materials
  // get a permanent home
  // on the class instead of living only in the notification email.
  const visibleMaterials = booking.materials.filter((m) =>
    materialSendTimeElapsed(m.sendTiming, booking.scheduledStart, now),
  );
  // Gap G3 — library items attached to this class, same send-time gate.
  const visibleLibraryMaterials = booking.libraryMaterials.filter((a) =>
    materialSendTimeElapsed(a.sendTiming, booking.scheduledStart, now),
  );
  const materialsStorage =
    visibleMaterials.some((m) => m.storagePath) ||
    visibleLibraryMaterials.some((a) => a.material.storagePath)
      ? getStorageProvider()
      : null;
  // Signing the material URLs and querying the shelf are independent — the
  // shelf used to wait behind every signed URL resolving first.
  const [materials, atLevelMaterials] = await Promise.all([
    Promise.all([
      ...visibleMaterials.map(async (m) => ({
        id: m.id,
        label: m.label,
        attachmentKind: (m.storagePath ? "file" : "link") as "file" | "link",
        isImage: isImageFileName(m.storagePath),
        viewUrl: await pickMaterialsUrl(materialsStorage, {
          storagePath: m.storagePath,
          linkUrl: m.linkUrl,
        }),
        levelLabel: (m.levelId ? levelLabelById.get(m.levelId) : undefined) ?? "",
        tags: tagsOf(m.focusTags),
      })),
      ...visibleLibraryMaterials.map(async (a) => ({
        id: a.libraryMaterialId,
        label: a.material.label,
        attachmentKind: (a.material.storagePath ? "file" : "link") as "file" | "link",
        // A body-bearing item resolves to its PDF below, so it is never an
        // inline image even when it also carries an image file.
        isImage: !a.material.body && isImageFileName(a.material.storagePath),
        viewUrl: a.material.body
          ? `/api/materials/${a.libraryMaterialId}/pdf`
          : await pickMaterialsUrl(materialsStorage, {
              storagePath: a.material.storagePath,
              linkUrl: a.material.linkUrl,
            }),
        levelLabel: (a.material.levelId ? levelLabelById.get(a.material.levelId) : undefined) ?? "",
        tags: tagsOf(a.material.focusTags),
      })),
    ]),
    // Gap G4 — opt-in, read-only "at your level" shelf (reuses the levels +
    // this student's level fetched above).
    booking.teacher.autoSurfaceLevelMaterials
      ? (async () => {
          const attachedIds = new Set(booking.libraryMaterials.map((a) => a.libraryMaterialId));
          const rows = await prisma.libraryMaterial.findMany({
            where: libraryBrowseWhere(booking.teacherId, teacherLevels, studentLink?.levelId),
            select: { id: true, label: true },
            orderBy: { position: "asc" },
            take: 10,
          });
          return rows.filter((r) => !attachedIds.has(r.id));
        })()
      : [],
  ]);
  // Organize the class's materials the same way the student's account page does
  // — by category, one primary bucket each, tags/level as chips.
  const materialGroups = groupMaterialsByCategory(materials, teacherCategories, "");

  const scheduleChangesAllowed = scheduleChangeBudget(booking.package.classesTotal);
  const scheduleChangesLeft = Math.max(
    0,
    scheduleChangesAllowed - booking.package.scheduleChangesUsed,
  );
  const eligibility = canStudentRescheduleBooking({
    now,
    scheduledStart: booking.scheduledStart,
    status: booking.status,
    scheduleChangesUsed: booking.package.scheduleChangesUsed,
    scheduleChangesAllowed,
  });

  const isScheduled = booking.status === "scheduled";
  const isPast = booking.scheduledStart <= now;

  // D-15: the live notes panel opens only inside the class window (derived from
  // the schedule, no stored flag). Outside it, instructions stay hidden. We pass
  // the window state down so the client panel subscribes to Realtime while it's
  // open even before the first instruction exists (phase 1c).
  const liveWindowOpen = lessonNoteStudentVisible(
    booking.scheduledStart,
    booking.scheduledEnd,
    now,
  );
  const liveNotes = liveWindowOpen ? booking.lessonNotes : [];

  // Only surface the "Join video call" button when the call genuinely works for
  // this booking — the teacher is on Pro (the call rides her plan) AND LiveKit is
  // configured. A Free teacher's student then sees the live-notes card with no
  // button that would just land on a "not available" wall. Same two checks the
  // call page enforces, so the button and the page agree.
  const callAvailable =
    isScheduled &&
    !!getVideoProvider() &&
    (await gateProFeature(booking.teacherId, "lesson_notes")).ok;

  // "Add to calendar" only makes sense for a class that's still ahead.
  const calendar =
    booking.status === "scheduled" && !isPast
      ? buildBookingCalendarLinks({
          uid: `booking-${booking.id}@spiralclass.com`,
          booking: {
            start: booking.scheduledStart,
            end: booking.scheduledEnd,
            title: t("web.myClasses.confirmation.calendarTitle", { name: booking.teacher.name }),
          },
        })
      : null;

  // One-tap rebook: when the class is completed (manual or auto) and the
  // package still has classes left and isn't expired/refunded, surface a
  // "rebook same time next week" CTA. The slot picker handles unavailability
  // gracefully — if next-week's slot is taken, it shows what's open that day.
  const showRebookPrompt =
    booking.status === "completed" &&
    booking.package.status === "active" &&
    booking.package.classesUsed < booking.package.classesTotal &&
    (!booking.package.expiresAt || booking.package.expiresAt > now);
  const rebookDate = showRebookPrompt
    ? nextWeekSameDayInZone(booking.scheduledStart, booking.teacher.timezone)
    : null;

  const rulePreview = isScheduled
    ? buildCancelRulePreview(booking.scheduledStart, now, t)
    : t("web.myClasses.detail.cannotChange");

  // Dual-timezone display standard: this student viewer's own local time
  // (falling back to the teacher's when unset) is primary, the teacher's is
  // secondary — always both, even when the two zones match.
  const studentWhen = (d: Date) =>
    bookingWhen(
      d,
      student.timezone ?? booking.teacher.timezone,
      { tz: booking.teacher.timezone, label: booking.teacher.name },
      locale,
      t,
    );

  return (
    <PageShell width="reading">
      <BackLink href="/my-classes" label={t("web.myClasses.title")} />

      <Card>
        <CardHeader>
          <CardTitle>{studentWhen(booking.scheduledStart).when}</CardTitle>
          <p className="text-muted-foreground text-xs">{t("web.dualZone.yourTime")}</p>
          <p className="text-muted-foreground text-sm">
            {studentWhen(booking.scheduledStart).whenSecondary}
          </p>
          <CardDescription>
            {t("web.myClasses.withTeacher")}
            <TeacherNameLink teacherId={booking.teacher.id} name={booking.teacher.name} /> ·{" "}
            <StatusLabel status={booking.status} t={t} />
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {studentLevelLabel && (
            <p className="font-medium">{t("library.yourLevel", { level: studentLevelLabel })}</p>
          )}
          {calendar && (
            <div className="pb-1">
              <AddToCalendar googleUrl={calendar.googleUrl} icsContent={calendar.ics} />
            </div>
          )}
          <PackageDetailsSheet packageId={booking.package.id} className="-mx-1 px-1 py-0.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("web.myClasses.detail.package")}</span>
              <span>
                {booking.package.template?.name ?? t("web.myClasses.detail.package")} ·{" "}
                {booking.package.classesTotal - booking.package.classesUsed}{" "}
                {t("web.myClasses.detail.remaining")}
              </span>
            </div>
          </PackageDetailsSheet>
          {booking.rescheduleOf && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("web.myClasses.detail.movedFrom")}</span>
              <span className="flex flex-col items-end">
                <span>{studentWhen(booking.rescheduleOf.scheduledStart).when}</span>
                <span className="text-muted-foreground text-xs">
                  {studentWhen(booking.rescheduleOf.scheduledStart).whenSecondary}
                </span>
              </span>
            </div>
          )}
          {booking.reschedules.length > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                {t("web.myClasses.detail.rescheduledTo")}
              </span>
              <span className="flex flex-col items-end">
                <span>{studentWhen(booking.reschedules[0].scheduledStart).when}</span>
                <span className="text-muted-foreground text-xs">
                  {studentWhen(booking.reschedules[0].scheduledStart).whenSecondary}
                </span>
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Join the call any time the class is still on the calendar — not just
          during the live window — but only when the call genuinely works for this
          booking (teacher on Pro + LiveKit configured), so a Free teacher's
          student never sees a button that goes nowhere. The live-notes panel
          below stays window-gated (D-15). Styled as the primary CTA rather
          than a plain card so it's unmissable near the top of the page. */}
      {callAvailable && (
        <CallCta
          href={`/my-classes/${booking.id}/call`}
          title={t("call.title")}
          subtitle={
            liveWindowOpen
              ? t("web.myClasses.detail.classHappeningNow")
              : t("web.myClasses.detail.joinClassVideoCall")
          }
          cta={t("web.myClasses.detail.joinVideoCall")}
        />
      )}
      {liveWindowOpen && <StudentLiveNotes notes={liveNotes} windowOpen={liveWindowOpen} />}

      {classContent && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.myClasses.content.title")}</CardTitle>
            <CardDescription>{t("web.myClasses.detail.contentDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ClassContentMarkdown body={classContent.body} />
            {(classContentFileUrl || classContent.linkUrl) && (
              <div className="flex flex-wrap gap-3">
                {classContentFileUrl && (
                  <a
                    href={classContentFileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm underline"
                  >
                    {t("web.myClasses.detail.materialFile")}
                  </a>
                )}
                {classContent.linkUrl && (
                  <a
                    href={classContent.linkUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm underline"
                  >
                    {t("web.myClasses.detail.materialLink")}
                  </a>
                )}
              </div>
            )}
            <Link
              href={`/my-classes/${booking.id}/content`}
              className="inline-block text-sm underline"
            >
              {t("web.myClasses.detail.openSaveAsPdf")}
            </Link>
          </CardContent>
        </Card>
      )}

      {/* This class's own materials come before the generic "at your level"
          shelf — the attachments for today's lesson are what the student most
          often opens from here. */}
      {materials.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.myClasses.detail.classMaterials")}</CardTitle>
            <CardDescription>{t("web.myClasses.detail.materialsDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {materials.length > MATERIALS_COLLAPSE_THRESHOLD ? (
              <Collapsible
                title={t("materials.showMore", { count: materials.length })}
                defaultOpen={false}
              >
                <StudentMaterialGroups groups={materialGroups} t={t} />
              </Collapsible>
            ) : (
              <StudentMaterialGroups groups={materialGroups} t={t} />
            )}
          </CardContent>
        </Card>
      )}

      {atLevelMaterials.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.dashboard.classes.atLevel.title")}</CardTitle>
            <CardDescription>{t("web.myClasses.detail.atLevelDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {atLevelMaterials.map((m) => (
              <div key={m.id} className="rounded-md border px-3 py-2 text-sm">
                <span className="truncate font-medium">
                  {m.label ?? t("web.materials.materialFallback")}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {homework.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("homework.section.title")}</CardTitle>
            <CardDescription>{t("homework.web.openToSubmit")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {homework.map((a) => (
              <Link
                key={a.id}
                href={`/my-classes/${booking.id}/homework/${a.id}`}
                className="hover:bg-muted/50 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm transition-colors"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-medium">{a.title}</p>
                  <p className="text-muted-foreground text-xs">
                    {a.dueAt
                      ? t("homework.due", { date: studentWhen(new Date(a.dueAt)).when })
                      : t("homework.noDue")}
                    {a.fileCount > 0
                      ? ` · ${t("homework.filesCount", { count: a.fileCount })}`
                      : ""}
                  </p>
                </div>
                <HomeworkStatusBadge status={a.status} t={t} />
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {isScheduled && !isPast && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.myClasses.detail.needToMove")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {eligibility.ok && (
              <div className="space-y-2">
                <Button asChild>
                  <Link href={`/my-classes/${booking.id}/reschedule`}>
                    {t("web.myClasses.detail.rescheduleThisClass")}
                  </Link>
                </Button>
                <p className="text-muted-foreground text-xs">
                  {scheduleChangesLeft === 1
                    ? t("web.myClasses.detail.scheduleChangesLeftOne")
                    : t("web.myClasses.detail.scheduleChangesLeft", {
                        n: scheduleChangesLeft,
                      })}
                </p>
              </div>
            )}
            {!eligibility.ok && (
              <p className="text-muted-foreground text-sm">
                {rescheduleRejectMessage(eligibility.reason, t)}
              </p>
            )}
            <StudentCancelForm
              bookingId={booking.id}
              rulePreview={rulePreview}
              rescheduleEligible={eligibility.ok}
              rescheduleHref={`/my-classes/${booking.id}/reschedule`}
            />
          </CardContent>
        </Card>
      )}

      {showRebookPrompt && rebookDate && (
        <Card className="border-success/30 bg-success-bg">
          <CardHeader>
            <CardTitle className="text-lg">{t("web.myClasses.detail.bookTheNextOne")}</CardTitle>
            <CardDescription>
              {t("web.myClasses.detail.rebookPrompt", {
                n: booking.package.classesTotal - booking.package.classesUsed,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={`/my-classes/book?packageId=${booking.package.id}&date=${rebookDate}`}>
                {t("web.myClasses.detail.bookTheNextClass")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {overrides.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.myClasses.detail.notesFromTeacher")}</CardTitle>
            <CardDescription>{t("web.myClasses.detail.manualChangesDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {overrides.map((o) => (
              <div key={o.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="font-medium">{overrideLabel(o.action, t)}</div>
                <p className="text-muted-foreground">{o.reason}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}

function materialTitle(
  m: { label: string | null; attachmentKind: "file" | "link" },
  t: TFunction,
): string {
  if (m.label) return m.label;
  if (m.attachmentKind === "file") return t("web.myClasses.detail.materialFile");
  return t("web.myClasses.detail.materialLink");
}

// Extracted so the collapsed and expanded render paths share one
// implementation instead of drifting apart.
function StudentMaterialGroups({
  groups,
  t,
}: {
  groups: {
    categoryId: string | null;
    categoryLabel: string;
    items: {
      id: string;
      label: string | null;
      attachmentKind: "file" | "link";
      viewUrl: string | null;
      // Set by the callers that resolve a real storage path; the preview is
      // simply skipped where it's absent.
      isImage?: boolean;
      levelLabel: string;
      tags: MaterialTag[];
    }[];
  }[];
  t: TFunction;
}) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.categoryId ?? "__other__"} className="space-y-2">
          <p className="text-muted-foreground text-xs font-semibold">
            {g.categoryId === null ? t("library.otherCategory") : g.categoryLabel}
          </p>
          {g.items.map((m) => (
            <div key={m.id} className="rounded-md border px-3 py-2 text-sm">
              {m.viewUrl ? (
                <a
                  href={m.viewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-medium underline"
                >
                  {materialTitle(m, t)}
                </a>
              ) : (
                <span className="truncate font-medium">{materialTitle(m, t)}</span>
              )}
              {m.isImage && m.viewUrl && (
                <MaterialImagePreview viewUrl={m.viewUrl} label={m.label} className="mt-2" />
              )}
              {(m.levelLabel || m.tags.length > 0) && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {[m.levelLabel, ...m.tags.map((tag) => tag.label)]
                    .filter(Boolean)
                    .map((chip, i) => (
                      <span
                        key={`${chip}-${i}`}
                        className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs"
                      >
                        {chip}
                      </span>
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// Returns the YYYY-MM-DD date that is exactly 7 days after `start` as it
// reads in the teacher's timezone. The slot picker accepts a YYYY-MM-DD
// query param interpreted in the teacher's tz, so this stays stable across
// DST shifts (e.g., last week at 09:00 local is still 09:00 local next
// week even if UTC offset changed).
function nextWeekSameDayInZone(start: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(start);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 7);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildCancelRulePreview(start: Date, now: Date, t: TFunction): string {
  const hoursAhead = (start.getTime() - now.getTime()) / (60 * 60 * 1000);
  if (hoursAhead >= 24) {
    return t("web.myClasses.detail.cancelPreview.moreThan24h");
  }
  return t("web.myClasses.detail.cancelPreview.lessThan24h");
}

function StatusLabel({ status, t }: { status: string; t: TFunction }) {
  const map: Record<string, string> = {
    scheduled: t("web.myClasses.detail.status.scheduled"),
    completed: t("web.myClasses.detail.status.completed"),
    canceled_by_student: t("web.myClasses.detail.status.canceledByStudent"),
    canceled_by_teacher: t("web.myClasses.detail.status.canceledByTeacher"),
    rescheduled: t("web.myClasses.detail.status.rescheduled"),
    no_show: t("web.myClasses.detail.status.noShow"),
  };
  return <span>{map[status] ?? status}</span>;
}

function rescheduleRejectMessage(reason: string, t: TFunction): string {
  switch (reason) {
    case "lt24h":
      return t("web.myClasses.detail.rescheduleReject.lt24h");
    case "schedule-changes-exhausted":
      return t("web.myClasses.detail.rescheduleReject.exhausted");
    case "booking-not-scheduled":
      return t("web.myClasses.detail.rescheduleReject.notScheduled");
    default:
      return t("web.myClasses.detail.rescheduleReject.default");
  }
}

function overrideLabel(action: string, t: TFunction): string {
  switch (action) {
    case "teacher_book_class":
      return t("web.myClasses.detail.override.teacherBookClass");
    case "teacher_cancel":
      return t("web.myClasses.detail.override.teacherCancel");
    case "mark_complete":
      return t("web.myClasses.detail.override.markComplete");
    case "mark_no_show":
      return t("web.myClasses.detail.override.markNoShow");
    case "restore_class":
      return t("web.myClasses.detail.override.restoreClass");
    case "waive_cancellation":
      return t("web.myClasses.detail.override.waiveCancellation");
    case "extend_expiration":
      return t("web.myClasses.detail.override.extendExpiration");
    default:
      return action;
  }
}
