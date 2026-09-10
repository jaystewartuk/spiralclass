import { Heading } from "@/components/ui/heading";
import { PageShell } from "@/components/ui/page-shell";
import { notFound } from "next/navigation";
import {
  contentKindLabel,
  contentKindSummary,
  planReasonText,
  platformLabel,
} from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { getActivity, promoPolicyFor } from "@/lib/marketing/activities";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionNav } from "../section-nav";
import { MarkDoneButton } from "./mark-done-button";
import { PreparePanel } from "./prepare-panel";
import { SkipButton } from "./skip-button";

// One prepared action, end to end. `getActivity` is teacher-scoped, so an id
// belonging to another teacher is a 404 rather than a leak.
export default async function ActivityPage({
  params,
}: {
  params: Promise<{ activityId: string }>;
}) {
  const { activityId } = await params;
  const teacher = await requireOnboardedTeacher();
  const t = await getT();
  const locale = await getPreferredLocale();

  const activity = await getActivity(teacher.id, activityId);
  if (!activity) notFound();

  const promoPolicy = await promoPolicyFor(
    teacher.id,
    activity.community?.id ?? null,
    activity.platform,
  );

  return (
    <PageShell width="default">
      <SectionNav current="plan" />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Heading level={2} as="h1">
            {contentKindLabel(activity.kind, locale)}
          </Heading>
          <Badge variant="outline">
            {activity.community?.name ??
              activity.student?.name ??
              platformLabel(activity.platform, locale)}
          </Badge>
          {activity.status === "done" && (
            <Badge variant="success">{t("web.getStudents.done")}</Badge>
          )}
          {activity.status === "skipped" && (
            <Badge variant="outline">{t("web.getStudents.skipped")}</Badge>
          )}
        </div>
        <p className="text-muted-foreground text-sm">{contentKindSummary(activity.kind, locale)}</p>
        {activity.reason && (
          <div className="space-y-1 pt-2">
            <div className="text-sm font-medium">{t("web.getStudents.whyThis")}</div>
            <p className="text-sm">{planReasonText(activity.reason, locale)}</p>
          </div>
        )}
      </div>

      <PreparePanel
        activityId={activity.id}
        kind={activity.kind}
        platform={activity.platform}
        promoPolicy={promoPolicy}
        body={activity.body}
        title={activity.title}
        angleNote={activity.angleNote}
        trackedLink={activity.trackedLink}
        imageUrl={activity.imageUrl}
        communityUrl={activity.community?.url ?? null}
      />

      {activity.status !== "done" && (
        <div className="flex flex-wrap items-start gap-2">
          <MarkDoneButton activityId={activity.id} />
          {activity.status !== "skipped" && <SkipButton activityId={activity.id} />}
        </div>
      )}

      {activity.status === "done" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.getStudents.activityResults")}</CardTitle>
          </CardHeader>
          {/* A `<dl>`, so each figure is announced with the word it belongs
              to instead of as three loose numbers. */}
          <CardContent>
            <dl className="grid grid-cols-3 gap-4">
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">{t("web.getStudents.visits")}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{activity.results.visits}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">{t("web.getStudents.enquiries")}</dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  {activity.results.enquiries}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">
                  {t("web.getStudents.newStudents")}
                </dt>
                <dd className="text-2xl font-semibold tabular-nums">{activity.results.students}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
