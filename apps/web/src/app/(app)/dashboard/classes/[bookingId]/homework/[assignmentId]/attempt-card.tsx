"use client";

import { useActionState } from "react";
import type {
  HomeworkAiReviewDraft,
  HomeworkAttempt,
  HomeworkFeedbackDecision,
} from "@spiralclass/shared";
import { HOMEWORK_FEEDBACK_MAX_SCORE } from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/components/locale-provider";
import {
  createHomeworkFeedbackAction,
  requestAiReviewAction,
  type CreateFeedbackState,
  type RequestAiReviewState,
} from "@/app/actions/homework";
import { formatZonedDateTime } from "@/lib/date-display";

// One attempt in the teacher review screen: its text/files, either its
// existing feedback (read-only) or the three-way decision form when it still
// needs one. A resubmission after allowResubmission (rather than after a
// teacher decision) can leave more than one un-reviewed attempt, so the form
// isn't restricted to the latest row — only the latest attempt's decision
// actually moves the submission's current status (lib/homework/feedback.ts).
export function HomeworkAttemptCard({
  attempt,
  isLatest,
  bookingId,
  assignmentId,
  teacherTimezone,
  locale,
}: {
  attempt: HomeworkAttempt;
  isLatest: boolean;
  bookingId: string;
  assignmentId: string;
  teacherTimezone: string;
  locale: string;
}) {
  const t = useT();
  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            {t("homework.teacher.review.attemptLabel", { number: String(attempt.attemptNumber) })}
            {isLatest ? ` · ${t("homework.teacher.review.latest")}` : ""}
          </CardTitle>
          {attempt.feedback ? (
            <DecisionBadge decision={attempt.feedback.decision} />
          ) : (
            <Badge variant="warning">{t("homework.teacher.review.pendingReview")}</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("homework.teacher.review.submittedAt", {
            date: formatZonedDateTime(new Date(attempt.submittedAt), teacherTimezone, locale),
          })}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {attempt.textResponse && (
          <p className="text-sm whitespace-pre-wrap">{attempt.textResponse}</p>
        )}
        {attempt.files.length > 0 && (
          <ul className="space-y-1 text-sm">
            {attempt.files.map((f) => (
              <li key={f.id}>
                <a
                  href={f.viewUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {f.fileName}
                </a>
              </li>
            ))}
          </ul>
        )}

        {attempt.feedback ? (
          <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
            <p className="whitespace-pre-wrap">{attempt.feedback.content}</p>
            {attempt.feedback.score != null && (
              <p className="text-xs text-muted-foreground">
                {t("homework.teacher.review.scoreDisplay", {
                  score: String(attempt.feedback.score),
                  max: String(HOMEWORK_FEEDBACK_MAX_SCORE),
                })}
              </p>
            )}
          </div>
        ) : (
          <>
            <AiReviewPanel
              attemptId={attempt.id}
              bookingId={bookingId}
              assignmentId={assignmentId}
              drafts={attempt.aiReviewDrafts}
            />
            <FeedbackForm
              attemptId={attempt.id}
              bookingId={bookingId}
              assignmentId={assignmentId}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// "Review with AI" (docs/features/homework.md) — a
// teacher-triggered Claude draft the teacher can read, then copy/edit into the
// feedback form below. Never auto-fills the form (a teacher must actively
// decide to use it) — that keeps "teacher approval is the default" true even
// when a draft exists.
function AiReviewPanel({
  attemptId,
  bookingId,
  assignmentId,
  drafts,
}: {
  attemptId: string;
  bookingId: string;
  assignmentId: string;
  drafts: HomeworkAiReviewDraft[];
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<RequestAiReviewState, FormData>(
    requestAiReviewAction,
    undefined,
  );
  const latest = drafts[0] ?? null;

  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="attemptId" value={attemptId} />
        <input type="hidden" name="bookingId" value={bookingId} />
        <input type="hidden" name="assignmentId" value={assignmentId} />
        <div className="space-y-1">
          <Label htmlFor={`ai-instructions-${attemptId}`}>
            {t("homework.teacher.review.ai.instructionsLabel")}
          </Label>
          <Textarea
            id={`ai-instructions-${attemptId}`}
            name="instructions"
            rows={2}
            placeholder={t("homework.teacher.review.ai.instructionsPlaceholder")}
          />
        </div>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending
            ? t("homework.teacher.review.ai.loading")
            : latest
              ? t("homework.teacher.review.ai.regenerate")
              : t("homework.teacher.review.ai.button")}
        </Button>
        {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      </form>

      {latest && <AiReviewDraftCard draft={latest} />}
    </div>
  );
}

function AiReviewDraftCard({ draft }: { draft: HomeworkAiReviewDraft }) {
  const t = useT();
  const { content } = draft;
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t("homework.teacher.review.ai.draftTitle")}</p>
      {content.suggestedScore != null && (
        <p className="text-xs text-muted-foreground">
          {t("homework.teacher.review.ai.suggestedScore", {
            score: String(content.suggestedScore),
            max: String(HOMEWORK_FEEDBACK_MAX_SCORE),
          })}
        </p>
      )}
      <div>
        <p className="text-xs font-medium text-muted-foreground">
          {t("homework.teacher.review.ai.suggestedFeedback")}
        </p>
        <p className="whitespace-pre-wrap">{content.suggestedFeedback}</p>
      </div>
      <BulletSection
        label={t("homework.teacher.review.ai.corrections")}
        items={content.corrections}
      />
      <BulletSection label={t("homework.teacher.review.ai.strengths")} items={content.strengths} />
      <BulletSection
        label={t("homework.teacher.review.ai.weaknesses")}
        items={content.weaknesses}
      />
      {content.grammarNotes && content.grammarNotes.length > 0 && (
        <BulletSection
          label={t("homework.teacher.review.ai.grammarNotes")}
          items={content.grammarNotes}
        />
      )}
    </div>
  );
}

function BulletSection({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <ul className="list-disc pl-4">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: HomeworkFeedbackDecision }) {
  const t = useT();
  const variant =
    decision === "approved" ? "success" : decision === "rejected" ? "destructive" : "warning";
  return <Badge variant={variant}>{t(`homework.teacher.review.decision.${decision}`)}</Badge>;
}

function FeedbackForm({
  attemptId,
  bookingId,
  assignmentId,
}: {
  attemptId: string;
  bookingId: string;
  assignmentId: string;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState<CreateFeedbackState, FormData>(
    createHomeworkFeedbackAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-3 rounded-md border bg-muted/40 p-3">
      <input type="hidden" name="attemptId" value={attemptId} />
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <div className="space-y-1">
        <Label htmlFor={`fb-content-${attemptId}`}>
          {t("homework.teacher.review.feedbackLabel")}
        </Label>
        <Textarea
          id={`fb-content-${attemptId}`}
          name="content"
          required
          maxLength={5000}
          rows={4}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`fb-score-${attemptId}`}>
          {t("homework.teacher.review.scoreLabel", { max: String(HOMEWORK_FEEDBACK_MAX_SCORE) })}
        </Label>
        <Input
          id={`fb-score-${attemptId}`}
          name="score"
          type="number"
          min={0}
          max={HOMEWORK_FEEDBACK_MAX_SCORE}
          className="w-24"
        />
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" name="decision" value="approved" disabled={pending}>
          {t("homework.teacher.review.approve")}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="resubmission_requested"
          variant="secondary"
          disabled={pending}
        >
          {t("homework.teacher.review.requestResubmission")}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="rejected"
          variant="destructive"
          disabled={pending}
        >
          {t("homework.teacher.review.reject")}
        </Button>
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
