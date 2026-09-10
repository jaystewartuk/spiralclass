import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { notFound } from "next/navigation";
import { requireStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { gateProFeature } from "@/lib/subscriptions/enforce";
import { liveCaptionsEnabled } from "@/lib/captions/config";
import { captionsPublishConsentOk } from "@/lib/captions/class-access";
import { lessonNoteStudentVisible } from "@/lib/lesson-notes/visibility";
import { studentIdentityIds } from "@/lib/students/identity";
import { getVideoProvider, classCallRoom } from "@/lib/video/provider";
import { getCallMaterials } from "@/lib/materials/call-materials";
import { nudgeFromStudent } from "@/app/actions/call-nudge";
import { Button } from "@/components/ui/button";
import { CallSessionBootstrap } from "@/components/video/call-session-bootstrap";
import { InstructionsOverlay } from "./instructions-overlay";
import { usesEnglishCopy } from "@spiralclass/shared";

// Student's in-class video call (live-notes-panel.md step 3, D-16). Mirrors the
// teacher side: gated only by the *teacher's* Pro plan (a student of a Free
// teacher is told it isn't enabled rather than shown an upgrade prompt — not
// their purchase) and by LiveKit being configured. Call *access* is no longer
// time-windowed — a student can join whenever the teacher can (e.g. a few minutes
// early), matching the teacher surface. The student's written instructions are
// still only revealed inside the class window (D-15), so joining early shows the
// call without leaking notes the teacher prepped ahead.
export default async function StudentCallPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = await params;
  const student = await requireStudent();
  const t = await getT();
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const backHref = `/my-classes/${bookingId}`;

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, studentId: { in: await studentIdentityIds(student) } },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      scheduledStart: true,
      scheduledEnd: true,
      lessonNotes: {
        where: { audience: "student" },
        select: { id: true, body: true },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!booking) notFound();

  // The teacher's plan owns this feature.
  const gate = await gateProFeature(booking.teacherId, "lesson_notes");
  if (!gate.ok) {
    return (
      <CallMessage backHref={backHref} t={t} body={t("web.myClasses.call.notEnabledForClass")} />
    );
  }

  const provider = getVideoProvider();
  if (!provider) {
    return <CallMessage backHref={backHref} t={t} body={t("web.myClasses.call.notSwitchedOn")} />;
  }

  const grant = await provider.mintToken({
    room: classCallRoom(booking.id),
    identity: student.id,
    name: student.name,
  });

  // Instructions are revealed only inside the class window (D-15), even though
  // the call itself can be joined earlier.
  const notesVisible = lessonNoteStudentVisible(
    booking.scheduledStart,
    booking.scheduledEnd,
    new Date(),
  );

  // The student's copy of the in-call materials: only released items (a
  // not-yet-sent material stays hidden — same gate as their class page), and
  // every `> [!answer]` callout cut out of the bodies. `audience` decides both;
  // see getCallMaterials for why the answer cut has to happen here rather than
  // in the renderer (this array is serialized straight into her RSC payload).
  const materials = await getCallMaterials(booking.id, { audience: "student" });

  // Consent gate (the captions architecture review P0): her own
  // mic may only be published to ASR if she's consented (or her guardian
  // has, via the teacher) — the teacher's captions toggle (D-27,
  // teacher-toggled) can turn her audio-forwarding ON, but can never bypass
  // this. Distinguished from "feature off entirely" so the call UI can
  // explain why her own speech isn't being captioned even while the
  // teacher's toggle is on. No `canCaption` is passed here — only the
  // teacher's own call page renders the toggle; see class-call.tsx's
  // canCaption doc comment.
  const captionsFeatureOn = liveCaptionsEnabled();
  const captionsConsent = captionsFeatureOn
    ? await captionsPublishConsentOk(booking, "student")
    : false;

  return (
    <CallSessionBootstrap
      grant={grant}
      backHref={backHref}
      callHref={`/my-classes/${booking.id}/call`}
      chatHref={`/my-classes/messages/${booking.teacherId}`}
      bookingId={booking.id}
      role="student"
      scheduledStartAt={booking.scheduledStart.toISOString()}
      captionsConsentMissing={captionsFeatureOn && !captionsConsent}
      materials={materials}
      onNudge={nudgeFromStudent.bind(null, booking.id)}
      overlay={
        <InstructionsOverlay
          notes={notesVisible ? booking.lessonNotes : []}
          windowOpen={notesVisible}
          en={en}
        />
      }
    />
  );
}

function CallMessage({ backHref, t, body }: { backHref: string; t: TFunction; body: string }) {
  return (
    <main className="container space-y-6 py-16 text-center lg:max-w-lg">
      <PageHeader title={t("web.myClasses.call.title")} />
      <p className="text-muted-foreground">{body}</p>
      <Button asChild variant="ghost">
        <Link href={backHref}>{t("web.myClasses.backToClass")}</Link>
      </Button>
    </main>
  );
}
