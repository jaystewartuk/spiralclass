import { notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BackLink } from "@/components/back-link";
import { HomeworkStatusBadge } from "@/components/homework-status-badge";
import { requireStudent } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { formatZonedDateTime } from "@/lib/date-display";
import { ApiAuthError } from "@/lib/api/auth";
import { resolveStudentAssignment } from "@/lib/homework/access";
import { attemptsForAssignment, findSubmission } from "@/lib/homework/submission";
import { canEditSubmission, canSubmit, displayStatus } from "@/lib/homework/wire";
import {
  ALLOWED_SUBMISSION_FILE_TYPES,
  MAX_SUBMISSION_FILE_BYTES,
  mintSubmissionSignedUrl,
} from "@/lib/storage/homework-file";
import { SubmissionForm } from "./submission-form";

// The student's assignment detail + hand-in screen. Until this page, a student
// could see that homework had been set and could not act on it: submitting and
// reading feedback were unreachable, which is why `homework.web.completeInApp`
// no longer exists.
//
// Ownership is `resolveStudentAssignment`'s (the assignment's booking must
// belong to a Student row sharing this caller's email); the bookingId in the
// URL is then checked against the assignment's own, so a valid assignment id
// cannot be rendered under someone else's class URL.

export default async function StudentHomeworkPage({
  params,
}: {
  params: Promise<{ bookingId: string; assignmentId: string }>;
}) {
  const { bookingId, assignmentId } = await params;
  const student = await requireStudent();
  const t = await getT();
  const locale = await getPreferredLocale();

  let resolved;
  try {
    resolved = await resolveStudentAssignment(student, assignmentId);
  } catch (err) {
    if (err instanceof ApiAuthError) notFound();
    throw err;
  }
  const { assignment, studentId } = resolved;
  // The URL must agree with the assignment's own class, or this is a
  // hand-assembled path rather than a link we rendered.
  if (assignment.bookingId !== bookingId) notFound();

  const booking = await prisma.booking.findUnique({
    where: { id: assignment.bookingId },
    select: { teacher: { select: { name: true, timezone: true } } },
  });
  if (!booking) notFound();

  const tz = student.timezone ?? booking.teacher.timezone;
  const when = (d: Date) => formatZonedDateTime(d, tz, locale);

  const submission = await findSubmission(assignment.id, studentId);
  const now = new Date();
  const status = displayStatus(submission, assignment.dueAt);
  const editable = canEditSubmission(submission, assignment.allowResubmission);
  const submittable = canSubmit(submission, assignment, now);
  const pastDue = assignment.dueAt != null && assignment.dueAt.getTime() < now.getTime();

  const files = await Promise.all(
    [...(submission?.files ?? [])]
      .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime())
      .map(async (f) => ({
        id: f.id,
        fileName: f.fileName,
        fileSize: f.fileSize,
        viewUrl: await mintSubmissionSignedUrl(f.storagePath),
      })),
  );

  // The hand-in history, newest first, with the teacher's reply on each round.
  //
  // Built by hand rather than through `toWireAttempt`, deliberately: that helper
  // carries `aiReviewDrafts` — the teacher's private AI-drafted marking notes —
  // and this is a student-facing page. Mapping the fields explicitly is what
  // keeps a future field added to the wire type from leaking here by default.
  const attempts = (await attemptsForAssignment(assignment.id)).map((a) => ({
    id: a.id,
    attemptNumber: a.attemptNumber,
    submittedAt: when(a.submittedAt),
    feedback: a.feedback
      ? {
          decision: a.feedback.decision,
          content: a.feedback.content,
          score: a.feedback.score,
          createdAt: when(a.feedback.createdAt),
        }
      : null,
  }));
  const reviewed = attempts.filter((a) => a.feedback !== null);

  return (
    <PageShell width="reading">
      <BackLink href={`/my-classes/${bookingId}`} label={t("homework.detail.back")} />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <CardTitle>{assignment.title}</CardTitle>
              <CardDescription>
                {assignment.dueAt
                  ? t("homework.due", { date: when(assignment.dueAt) })
                  : t("homework.noDue")}
              </CardDescription>
            </div>
            <HomeworkStatusBadge status={status} t={t} />
          </div>
        </CardHeader>
        {assignment.instructions?.trim() && (
          <CardContent className="space-y-2">
            <p className="text-sm font-medium">{t("homework.detail.instructions")}</p>
            <p className="text-muted-foreground text-sm whitespace-pre-line">
              {assignment.instructions.trim()}
            </p>
          </CardContent>
        )}
      </Card>

      {reviewed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("homework.detail.feedback.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {reviewed.map((a) => (
              <div key={a.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      a.feedback!.decision === "approved"
                        ? "success"
                        : a.feedback!.decision === "rejected"
                          ? "destructive"
                          : "warning"
                    }
                  >
                    {t(`homework.detail.feedback.decision.${a.feedback!.decision}`)}
                  </Badge>
                  {a.feedback!.score != null && (
                    <span className="text-muted-foreground text-xs">
                      {t("homework.detail.feedback.scoreLabel", { score: a.feedback!.score })}
                    </span>
                  )}
                  <span className="text-muted-foreground text-xs">{a.feedback!.createdAt}</span>
                </div>
                <p className="text-sm whitespace-pre-line">{a.feedback!.content}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <SubmissionForm
        assignmentId={assignment.id}
        initialText={submission?.textResponse ?? ""}
        initialFiles={files}
        canEdit={editable}
        canSubmit={submittable}
        pastDue={pastDue}
        allowLateSubmission={assignment.allowLateSubmission}
        submittedAt={submission?.submittedAt ? when(submission.submittedAt) : null}
        // The allowlist and the cap come from the server's own constants, so
        // the picker and the client-side size check can never disagree with
        // what the finalize step will actually accept.
        accept={Object.keys(ALLOWED_SUBMISSION_FILE_TYPES).join(",")}
        maxBytes={MAX_SUBMISSION_FILE_BYTES}
      />
    </PageShell>
  );
}
