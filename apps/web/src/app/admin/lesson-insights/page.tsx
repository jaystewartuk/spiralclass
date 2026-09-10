import { requireAdmin } from "@/lib/admin";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { getT } from "@/lib/i18n";
import { transcriptionEnabled } from "@/lib/transcription/config";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CategoryBarChart, CHART_SERIES_COLOR } from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableShell,
} from "@/components/ui/table";
import { toBarSeries } from "@spiralclass/shared";

// The capture→brief pipeline stages, in sequence — one series (not distinct
// per-stage colors), since the chart's job is magnitude-across-stages, not
// stage identity.
type Stage =
  | "capturing"
  | "ready"
  | "transcribed"
  | "transcripts"
  | "insights"
  | "pronunciation"
  | "profiles"
  | "briefs";

const STAGE_ORDER: Stage[] = [
  "capturing",
  "ready",
  "transcribed",
  "transcripts",
  "insights",
  "pronunciation",
  "profiles",
  "briefs",
];

const STAGE_COLORS: Record<Stage, string> = STAGE_ORDER.reduce(
  (acc, key) => ({ ...acc, [key]: CHART_SERIES_COLOR }),
  {} as Record<Stage, string>,
);

// Lesson-insights PIPELINE HEALTH (D-05/D-21/D-22). A purpose-built operational
// view: row STATUSES, COUNTS and TIMESTAMPS only — deliberately NO transcript,
// pronunciation, insight or profile CONTENT. The voice-derived content is the
// the most sensitive data in the system, so it is not surfaced here; this
// view exists to operate and debug the pipeline (e.g. "captures land but no
// transcript"), not to read students' lessons. Superadmin-gated.

// A capture stuck on "recording" past this many minutes never finalised — the
// egress webhook didn't fire (or the egress failed) — and is worth a look.
const STUCK_MINUTES = 20;

export default async function AdminLessonInsightsPage() {
  await requireAdmin("superadmin");
  const t = await getT();

  const STAGE_LABELS: Record<Stage, string> = {
    capturing: t("web.admin.lessonInsights.stage.capturing"),
    ready: t("web.admin.lessonInsights.stage.ready"),
    transcribed: t("web.admin.lessonInsights.stage.transcribed"),
    transcripts: t("web.admin.lessonInsights.stage.transcripts"),
    insights: t("web.admin.lessonInsights.stage.insights"),
    pronunciation: t("web.admin.lessonInsights.stage.pronunciation"),
    profiles: t("web.admin.lessonInsights.stage.profiles"),
    briefs: t("web.admin.lessonInsights.stage.briefs"),
  };

  const txLive = transcriptionEnabled();
  const stuckCutoff = new Date(Date.now() - STUCK_MINUTES * 60_000);

  const [
    audioRecording,
    audioReady,
    audioTranscribed,
    audioDeleted,
    audioFailed,
    audioStuck,
    transcripts,
    insights,
    pronunciation,
    profiles,
    briefs,
    vocab,
    vocabDue,
    recRecording,
    recCompleted,
    recFailed,
    recStuck,
    recent,
  ] = await Promise.all([
    prisma.lessonAudio.count({ where: { status: "recording" } }),
    prisma.lessonAudio.count({ where: { status: "ready" } }),
    prisma.lessonAudio.count({ where: { status: "transcribed" } }),
    prisma.lessonAudio.count({ where: { status: "deleted" } }),
    prisma.lessonAudio.count({ where: { status: "failed" } }),
    prisma.lessonAudio.count({ where: { status: "recording", startedAt: { lt: stuckCutoff } } }),
    prisma.lessonTranscript.count(),
    prisma.lessonInsight.count(),
    prisma.lessonPronunciation.count(),
    prisma.studentLearningProfile.count(),
    prisma.lessonBrief.count(),
    prisma.vocabularyReview.count(),
    prisma.vocabularyReview.count({ where: { dueAt: { lte: new Date() } } }),
    prisma.callRecording.count({ where: { status: "recording" } }),
    prisma.callRecording.count({ where: { status: "completed" } }),
    prisma.callRecording.count({ where: { status: "failed" } }),
    prisma.callRecording.count({ where: { status: "recording", startedAt: { lt: stuckCutoff } } }),
    prisma.lessonAudio.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        bookingId: true,
        speaker: true,
        status: true,
        durationMs: true,
        createdAt: true,
        booking: { select: { teacher: { select: { name: true } } } },
      },
    }),
  ]);

  // The funnel's first stall point: audio captured and sitting at "ready" but no
  // transcript means transcription isn't running (flag/key/Inngest), the issue
  // most worth catching at a glance.
  const awaitingTranscription = audioReady;

  const funnelChartData = toBarSeries<Stage>(
    {
      capturing: audioRecording,
      ready: audioReady,
      transcribed: audioTranscribed,
      transcripts,
      insights,
      pronunciation,
      profiles,
      briefs,
    },
    STAGE_ORDER,
    STAGE_LABELS,
    STAGE_COLORS,
  );

  return (
    <div className="space-y-6">
      {/* Standing reminder: transcription sends voice to the ASR vendor and
          stores a transcript, and the consent gate (D-22) is the only thing
          scoping it. Easy to forget the flag is on. */}
      {txLive && (
        <div className="border-warning/50 bg-warning-bg rounded-lg border px-4 py-3 text-sm">
          <span className="text-warning font-semibold">
            {t("web.admin.lessonInsights.liveWarning.title")}
          </span>{" "}
          {t("web.admin.lessonInsights.liveWarning.pre")}{" "}
          <strong>{t("web.admin.lessonInsights.liveWarning.strong")}</strong>{" "}
          {t("web.admin.lessonInsights.liveWarning.mid")}{" "}
          <em>{t("web.admin.lessonInsights.liveWarning.em")}</em>{" "}
          {t("web.admin.lessonInsights.liveWarning.midEnd")}{" "}
          <code className="bg-muted rounded px-1">LESSON_INSIGHTS_TRANSCRIPTION_ENABLED</code>{" "}
          {t("web.admin.lessonInsights.liveWarning.post")}
        </div>
      )}

      <header>
        <PageHeader title={t("web.admin.lessonInsights.title")} />
        <p className="text-muted-foreground text-sm">{t("web.admin.lessonInsights.subtitle")}</p>
      </header>

      {/* Health callouts first — the things that mean something is wrong. */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={t("web.admin.lessonInsights.awaitingTranscription")}
          value={awaitingTranscription}
          hint={t("web.admin.lessonInsights.awaitingTranscriptionHint")}
          danger={awaitingTranscription > 0}
        />
        <Stat
          label={t("web.admin.lessonInsights.stuckCaptures")}
          value={audioStuck}
          hint={t("web.admin.lessonInsights.stuckCapturesHint", { minutes: STUCK_MINUTES })}
          danger={audioStuck > 0}
        />
        <Stat
          label={t("web.admin.lessonInsights.stuckRecordings")}
          value={recStuck}
          hint={t("web.admin.lessonInsights.stuckRecordingsHint", { minutes: STUCK_MINUTES })}
          danger={recStuck > 0}
        />
        <Stat
          label={t("web.admin.lessonInsights.failedCaptures")}
          value={audioFailed}
          danger={audioFailed > 0}
        />
      </div>

      {/* Capture → transcript funnel. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.lessonInsights.funnelTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <CategoryBarChart data={funnelChartData} />
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <Stat
              label={t("web.admin.lessonInsights.stage.capturing")}
              value={audioRecording}
              hint={t("web.admin.lessonInsights.hint.capturing")}
            />
            <Stat
              label={t("web.admin.lessonInsights.stage.ready")}
              value={audioReady}
              hint={t("web.admin.lessonInsights.hint.ready")}
            />
            <Stat
              label={t("web.admin.lessonInsights.stage.transcribed")}
              value={audioTranscribed}
              hint={t("web.admin.lessonInsights.hint.transcribed")}
            />
            <Stat
              label={t("web.admin.lessonInsights.audioDiscarded")}
              value={audioDeleted}
              hint={t("web.admin.lessonInsights.hint.audioDiscarded")}
            />
            <Stat label={t("web.admin.lessonInsights.stage.transcripts")} value={transcripts} />
            <Stat label={t("web.admin.lessonInsights.insightsRows")} value={insights} />
            <Stat label={t("web.admin.lessonInsights.stage.pronunciation")} value={pronunciation} />
            <Stat label={t("web.admin.lessonInsights.learningProfiles")} value={profiles} />
            <Stat label={t("web.admin.lessonInsights.stage.briefs")} value={briefs} />
            <Stat
              label={t("web.admin.lessonInsights.vocabularyReviews")}
              value={vocab}
              hint={t("web.admin.lessonInsights.dueNow", { count: vocabDue })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Call recordings (the A/V mp4 — separate from analysis audio). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {t("web.admin.lessonInsights.callRecordingsTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 lg:grid-cols-3">
            <Stat label={t("web.admin.lessonInsights.recording")} value={recRecording} />
            <Stat label={t("web.admin.lessonInsights.completed")} value={recCompleted} />
            <Stat
              label={t("web.admin.lessonInsights.failed")}
              value={recFailed}
              danger={recFailed > 0}
            />
          </div>
        </CardContent>
      </Card>

      {/* Recent captures — metadata only (booking id, teacher, speaker, status). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {t("web.admin.lessonInsights.recentCapturesTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("web.admin.lessonInsights.noCaptures")}
            </p>
          ) : (
            <TableShell>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("web.admin.lessonInsights.colBooking")}</TableHead>
                    <TableHead>{t("web.admin.lessonInsights.colTeacher")}</TableHead>
                    <TableHead>{t("web.admin.lessonInsights.colSpeaker")}</TableHead>
                    <TableHead>{t("web.admin.lessonInsights.colStatus")}</TableHead>
                    <TableHead className="text-right">
                      {t("web.admin.lessonInsights.colDuration")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("web.admin.lessonInsights.colCaptured")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.bookingId.slice(0, 8)}</TableCell>
                      <TableCell>{r.booking.teacher.name}</TableCell>
                      <TableCell>{r.speaker}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs">
                        {r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs">
                        {r.createdAt.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableShell>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function statusVariant(status: string): "warning" | "success" | "info" | "destructive" {
  if (status === "failed") return "destructive";
  if (status === "recording" || status === "ready") return "warning";
  if (status === "transcribed" || status === "deleted") return "success";
  return "info";
}

function Stat({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: number | string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className={`mt-1 text-2xl font-semibold ${danger ? "text-destructive" : ""}`}>
          {value}
        </div>
        {hint ? <div className="text-muted-foreground mt-1 text-xs">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
