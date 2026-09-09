import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SpeakingTimeSummary } from "@/lib/lesson-notes/speaking-time";
import type { TFunction } from "@/lib/i18n-translate";

// Speaking-time / participation analytics (D-97) — teacher-facing, read-only.
// A plain server component (no interactivity needed): a two-segment bar plus
// the listening/speaking split, computed server-side from this booking's
// LessonAudio + LessonTranscript (see lib/lesson-notes/speaking-time.ts).
export function SpeakingTimeCard({ summary, t }: { summary: SpeakingTimeSummary; t: TFunction }) {
  const silencePct = Math.max(0, 100 - summary.teacherSharePct - summary.studentSharePct);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("web.dashboard.classes.speakingTime.title")}</CardTitle>
        <CardDescription>{t("web.dashboard.classes.speakingTime.help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary"
            style={{ width: `${summary.teacherSharePct}%` }}
            title={t("web.dashboard.classes.speakingTime.teacher")}
          />
          <div
            className="h-full bg-secondary-foreground/40"
            style={{ width: `${summary.studentSharePct}%` }}
            title={t("web.dashboard.classes.speakingTime.student")}
          />
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">
              {t("web.dashboard.classes.speakingTime.teacher")}
            </dt>
            <dd className="font-medium">{summary.teacherSharePct}%</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {t("web.dashboard.classes.speakingTime.student")}
            </dt>
            <dd className="font-medium">{summary.studentSharePct}%</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {t("web.dashboard.classes.speakingTime.silence")}
            </dt>
            <dd className="font-medium">{silencePct}%</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
