import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { notFound } from "next/navigation";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { isAudioOnlyRecordingKey } from "@/lib/video/recording";
import { lessonRecordingUrl } from "@/lib/storage/lesson-recording";
import { formatZonedDateTime } from "@/lib/date-display";
import { Button } from "@/components/ui/button";
import type { SpeakerUtterance } from "@/lib/transcription/types";
import { computeBookmarkTimeline } from "@/lib/lesson-notes/bookmarks";
import { ReplayViewer } from "./replay-viewer";

// Lesson replay (teacher-only) — pairs the recorded class video with its
// speaker-labelled, searchable transcript and the AI summary, one level below
// the class detail page. Gated behind the same Pro feature as recording
// itself (lesson_notes) since there's nothing to replay for a Free teacher —
// recording was never offered to them in the first place.
//
// Deliberately CallRecording-only for playback: LessonAudio is per-speaker
// analysis input for the transcription pipeline, not intended for playback
// (its rows move recording → ready → transcribed → deleted, per the schema
// comment), so it's never used as a video/audio src here.
export default async function LessonReplayPage({
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
      <ReplayMessage
        backHref={backHref}
        backLabel={t("present.back")}
        title={t("web.dashboard.classes.replay.title")}
        body={upgradeNudge(gate.limit, locale)}
        cta={{ href: "/settings/billing", label: t("settings.billing.upgrade") }}
      />
    );
  }

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId: teacher.id },
    select: {
      id: true,
      student: { select: { name: true } },
      callRecordings: {
        where: { status: "completed" },
        select: { storageKey: true },
        orderBy: { startedAt: "desc" },
        take: 1,
      },
      lessonTranscript: { select: { utterances: true, language: true } },
      lessonSummary: { select: { body: true, createdAt: true } },
      lessonAudio: { select: { startedAt: true } },
      lessonNotes: {
        where: { kind: "bookmark" },
        select: { id: true, body: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!booking) notFound();

  const recording = booking.callRecordings[0] ?? null;
  const transcript = booking.lessonTranscript;
  if (!recording && !transcript) {
    return (
      <ReplayMessage
        backHref={backHref}
        backLabel={t("present.back")}
        title={t("web.dashboard.classes.replay.title")}
        body={t("web.dashboard.classes.replay.notReadyBody")}
      />
    );
  }

  const recordingUrl = await lessonRecordingUrl(recording?.storageKey);
  const utterances = (transcript?.utterances as unknown as SpeakerUtterance[] | undefined) ?? [];
  const bookmarks = computeBookmarkTimeline(
    booking.lessonNotes,
    booking.lessonAudio.map((a) => a.startedAt),
  );

  return (
    <PageShell width="default">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={backHref}>{`← ${t("present.back")}`}</Link>
      </Button>
      <header>
        <PageHeader title={t("web.dashboard.classes.replay.title")} />
        <p className="text-sm text-muted-foreground">{booking.student.name}</p>
      </header>

      <ReplayViewer
        recordingUrl={recordingUrl}
        // D-135: the composite is audio-only now. Legacy `.mp4` rows recorded
        // before that are still video and still have to render as video, so the
        // player is chosen per recording rather than globally.
        recordingKind={isAudioOnlyRecordingKey(recording?.storageKey) ? "audio" : "video"}
        utterances={utterances}
        bookmarks={bookmarks}
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
      />
    </PageShell>
  );
}

function ReplayMessage({
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
    <PageShell width="reading" className="py-16 text-center">
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
    </PageShell>
  );
}
