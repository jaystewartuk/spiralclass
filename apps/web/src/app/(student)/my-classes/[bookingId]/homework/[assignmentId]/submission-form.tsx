"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/components/locale-provider";
import type { StringKey } from "@/lib/i18n-translate";
import {
  attachHomeworkFileAction,
  presignHomeworkFileAction,
  removeHomeworkFileAction,
  saveHomeworkDraftAction,
  submitHomeworkAction,
  type HomeworkActionError,
} from "@/app/actions/homework-submission";

// The student's hand-in editor: typed answer, attachments, save-draft, submit.
// It reuses the existing `homework.detail.*` catalog rather than inventing a
// second vocabulary for the same actions.
//
// The file upload is a two-step direct-to-R2 flow: ask the server for a
// presigned PUT, send the bytes straight to R2, then
// tell the server to record the row. The bytes never pass through the app
// server, which is what keeps a 25 MB PDF from hitting the request body limit.

type FileRow = { id: string; fileName: string; fileSize: number; viewUrl: string | null };

// Failure codes are mapped here rather than returned as sentences from the
// action, so every message resolves through the catalog in all three locales.
const ERROR_KEY: Record<HomeworkActionError, StringKey> = {
  "not-found": "homework.detail.actionFailed",
  "submission-locked": "homework.detail.locked",
  "past-due": "homework.detail.pastDue",
  "empty-submission": "homework.detail.emptyError",
  "bad-type": "homework.file.badType",
  "bad-path": "homework.detail.uploadFailed",
  "file-too-large": "homework.file.tooLarge",
  "not-uploaded": "homework.detail.uploadFailed",
  "upload-unavailable": "homework.detail.uploadFailed",
};

export function SubmissionForm({
  assignmentId,
  initialText,
  initialFiles,
  canEdit,
  canSubmit,
  pastDue,
  allowLateSubmission,
  submittedAt,
  accept,
  maxBytes,
}: {
  assignmentId: string;
  initialText: string;
  initialFiles: FileRow[];
  canEdit: boolean;
  canSubmit: boolean;
  pastDue: boolean;
  allowLateSubmission: boolean;
  submittedAt: string | null;
  /** Comma-separated MIME allowlist, from the server's own constant. */
  accept: string;
  maxBytes: number;
}) {
  const t = useT();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [text, setText] = useState(initialText);
  const [files, setFiles] = useState<FileRow[]>(initialFiles);
  const [error, setError] = useState<StringKey | null>(null);
  const [notice, setNotice] = useState<StringKey | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();

  const busy = pending || uploading;
  // A late hand-in is still allowed here (the assignment permits it) — warn
  // rather than block.
  const lateWarning = pastDue && allowLateSubmission && canSubmit;

  function report(result: { ok: true } | { ok: false; error: HomeworkActionError }) {
    if (result.ok) return true;
    setError(ERROR_KEY[result.error]);
    return false;
  }

  function saveDraft() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await saveHomeworkDraftAction(assignmentId, text.trim() || null);
      if (report(result)) {
        setNotice("homework.detail.draftSaved");
        router.refresh();
      }
    });
  }

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await submitHomeworkAction(assignmentId, text.trim() || null);
      if (report(result)) {
        setNotice("homework.detail.submitted");
        router.refresh();
      }
    });
  }

  async function upload(file: File) {
    setError(null);
    setNotice(null);
    if (file.size > maxBytes) {
      setError("homework.file.tooLarge");
      return;
    }
    setUploading(true);
    try {
      const ticket = await presignHomeworkFileAction(assignmentId, file.type);
      if (!ticket.ok) {
        setError(ERROR_KEY[ticket.error]);
        return;
      }
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) {
        setError("homework.detail.uploadFailed");
        return;
      }
      const attached = await attachHomeworkFileAction(assignmentId, {
        storagePath: ticket.storagePath,
        fileName: file.name,
        mimeType: file.type,
      });
      if (!attached.ok) {
        setError(ERROR_KEY[attached.error]);
        return;
      }
      setFiles((prev) => [
        ...prev,
        { id: attached.fileId, fileName: file.name, fileSize: file.size, viewUrl: null },
      ]);
      router.refresh();
    } catch {
      setError("homework.detail.uploadFailed");
    } finally {
      setUploading(false);
    }
  }

  function removeFile(fileId: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await removeHomeworkFileAction(assignmentId, fileId);
      if (report(result)) {
        setFiles((prev) => prev.filter((f) => f.id !== fileId));
        router.refresh();
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("homework.detail.yourSubmission")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {submittedAt && (
          <p className="text-sm text-muted-foreground">
            {t("homework.detail.submittedAt", { date: submittedAt })}
          </p>
        )}

        {!canEdit ? (
          <>
            <p className="text-sm text-muted-foreground">{t("homework.detail.locked")}</p>
            {text.trim() && <p className="text-sm whitespace-pre-line">{text}</p>}
          </>
        ) : (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="homework-answer">
              {t("homework.detail.textLabel")}
            </label>
            <Textarea
              id="homework-answer"
              rows={8}
              value={text}
              disabled={busy}
              placeholder={t("homework.detail.textPlaceholder")}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium">{t("homework.detail.attachments")}</p>
          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("homework.detail.noFiles")}</p>
          ) : (
            <ul className="space-y-2">
              {files.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    {f.viewUrl ? (
                      <a
                        href={f.viewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate underline underline-offset-2"
                      >
                        {f.fileName}
                      </a>
                    ) : (
                      <span className="truncate">{f.fileName}</span>
                    )}
                  </span>
                  {canEdit && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={t("homework.detail.removeFile")}
                      onClick={() => removeFile(f.id)}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canEdit && (
            <>
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept={accept}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Clear first: picking the same file twice in a row must
                  // still fire a change event.
                  e.target.value = "";
                  if (file) void upload(file);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                    {t("homework.detail.uploading")}
                  </>
                ) : (
                  t("homework.detail.addFile")
                )}
              </Button>
            </>
          )}
        </div>

        {lateWarning && <p className="text-sm text-warning">{t("homework.detail.lateWarning")}</p>}
        {pastDue && !allowLateSubmission && !submittedAt && (
          <p className="text-sm text-muted-foreground">{t("homework.detail.pastDue")}</p>
        )}
        {error && <p className="text-sm text-destructive">{t(error)}</p>}
        {notice && !error && (
          <p role="status" className="text-sm text-success">
            {t(notice)}
          </p>
        )}

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={saveDraft}>
              {pending ? t("homework.detail.savingDraft") : t("homework.detail.saveDraft")}
            </Button>
            <Button type="button" disabled={busy || !canSubmit} onClick={submit}>
              {t("homework.detail.submit")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
