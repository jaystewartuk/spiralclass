import { notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { BackLink } from "@/components/back-link";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { formatZonedDateTime } from "@/lib/date-display";
import { resolveTeacherAssignment } from "@/lib/homework/access";
import { attemptsForAssignment } from "@/lib/homework/submission";
import { toWireAttempt } from "@/lib/homework/wire";
import { ApiAuthError } from "@/lib/api/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HomeworkAttemptCard } from "./attempt-card";

// Teacher review screen (docs/features/homework.md): the full
// attempt history for one assignment, newest first, with the teacher's
// three-way decision form on whichever attempt still needs a review.
// SpiralClass is strictly 1-on-1 tutoring, so an assignment has at most one
// submission — this is that submission's history, not a per-student list.
export default async function HomeworkReviewPage({
  params,
}: {
  params: Promise<{ bookingId: string; assignmentId: string }>;
}) {
  const { bookingId, assignmentId } = await params;
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();

  const assignment = await resolveTeacherAssignment(teacher, assignmentId).catch((err) => {
    if (err instanceof ApiAuthError) return null;
    throw err;
  });
  if (!assignment || assignment.bookingId !== bookingId) notFound();

  const rawAttempts = await attemptsForAssignment(assignment.id);
  const attempts = await Promise.all(rawAttempts.map(toWireAttempt));

  return (
    <PageShell width="default">
      <BackLink href={`/dashboard/classes/${bookingId}`} label={t("homework.detail.back")} />

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{assignment.title}</CardTitle>
          {assignment.instructions && (
            <CardDescription className="whitespace-pre-wrap">
              {assignment.instructions}
            </CardDescription>
          )}
        </CardHeader>
        {assignment.dueAt && (
          <CardContent className="text-muted-foreground text-sm">
            {t("homework.due", {
              date: formatZonedDateTime(assignment.dueAt, teacher.timezone, locale),
            })}
          </CardContent>
        )}
      </Card>

      {attempts.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("homework.teacher.review.noAttempts")}</p>
      ) : (
        <div className="space-y-4">
          {attempts.map((attempt, i) => (
            <HomeworkAttemptCard
              key={attempt.id}
              attempt={attempt}
              isLatest={i === 0}
              bookingId={bookingId}
              assignmentId={assignment.id}
              teacherTimezone={teacher.timezone}
              locale={locale}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
