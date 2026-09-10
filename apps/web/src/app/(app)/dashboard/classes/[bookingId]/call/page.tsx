import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { notFound } from "next/navigation";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { getVideoProvider, classCallRoom } from "@/lib/video/provider";
import { getCallMaterials } from "@/lib/materials/call-materials";
import { recordingEnabled } from "@/lib/video/recording";
import { liveCaptionsEnabled } from "@/lib/captions/config";
import { nudgeFromTeacher } from "@/app/actions/call-nudge";
import { createLessonBookmark } from "@/app/actions/lesson-notes";
import { Button } from "@/components/ui/button";
import { CallSessionBootstrap } from "@/components/video/call-session-bootstrap";

// Teacher's in-class video call (live-notes-panel.md step 3, D-16). A platform-
// owned room with her private cues overlaid on the video. A Pro live surface,
// gated like present mode; degrades to a friendly screen when LiveKit isn't
// configured. The room is keyed by booking id; the token is minted per visit.
export default async function TeacherCallPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = await params;
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const backHref = `/dashboard/classes/${bookingId}`;

  const gate = await gateProFeature(teacher.id, "lesson_notes");
  if (!gate.ok) {
    return (
      <CallMessage
        backHref={backHref}
        backLabel={t("present.back")}
        title={t("call.title")}
        body={upgradeNudge(gate.limit, locale)}
        cta={{ href: "/settings/billing", label: t("settings.billing.upgrade") }}
      />
    );
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId: teacher.id },
    select: {
      id: true,
      studentId: true,
      scheduledStart: true,
      student: { select: { name: true } },
      lessonNotes: {
        where: { audience: "teacher", kind: "text" },
        select: { id: true, body: true, doneAt: true },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!booking) notFound();

  const provider = getVideoProvider();
  if (!provider) {
    return (
      <CallMessage
        backHref={backHref}
        backLabel={t("present.back")}
        title={t("call.title")}
        body={t("call.notConfigured")}
      />
    );
  }

  const grant = await provider.mintToken({
    room: classCallRoom(booking.id),
    identity: teacher.id,
    name: teacher.name,
  });

  // The teacher sees every material attached to the class in the in-call viewer
  // (no send-timing gate — releasing is a student-facing concern).
  const materials = await getCallMaterials(booking.id, { audience: "teacher" });

  return (
    <CallSessionBootstrap
      grant={grant}
      backHref={backHref}
      callHref={`/dashboard/classes/${booking.id}/call`}
      chatHref={`/dashboard/messages/${booking.studentId}`}
      overlay={
        <CueOverlay
          cues={booking.lessonNotes}
          myCuesLabel={t("web.dashboard.classes.call.myCues")}
        />
      }
      canRecord={recordingEnabled()}
      canCaption={liveCaptionsEnabled()}
      bookingId={booking.id}
      role="teacher"
      scheduledStartAt={booking.scheduledStart.toISOString()}
      materials={materials}
      canBrowseLibrary
      onNudge={nudgeFromTeacher.bind(null, booking.id)}
      onBookmark={createLessonBookmark.bind(null, booking.id)}
    />
  );
}

function CueOverlay({
  cues,
  myCuesLabel,
}: {
  cues: { id: string; body: string; doneAt: Date | null }[];
  myCuesLabel: string;
}) {
  // No cues → render nothing, so the call's overlay slot stays collapsed rather
  // than showing an empty "My cues" card floating over the video: the overlay
  // only mounts when `cues.length > 0`. The card chrome lives here (not in
  // ClassCall's overlay
  // wrapper) precisely so that returning null shows no container at all.
  if (cues.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg bg-background/90 p-3 text-foreground shadow-lg backdrop-blur">
      <h3 className="text-sm font-medium text-muted-foreground">{myCuesLabel}</h3>
      <ul className="space-y-1 text-sm">
        {cues.map((c) => (
          <li key={c.id} className={c.doneAt ? "text-muted-foreground line-through" : ""}>
            {c.body}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CallMessage({
  backHref,
  backLabel,
  title,
  body,
  cta,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  body: string;
  cta?: { href: string; label: string };
}) {
  return (
    <main className="container space-y-6 py-16 text-center lg:max-w-lg">
      <PageHeader title={title} />
      <p className="text-muted-foreground">{body}</p>
      <div className="flex justify-center gap-3">
        {cta && (
          <Button asChild>
            <Link href={cta.href}>{cta.label}</Link>
          </Button>
        )}
        <Button asChild variant="ghost">
          <Link href={backHref}>{`← ${backLabel}`}</Link>
        </Button>
      </div>
    </main>
  );
}
