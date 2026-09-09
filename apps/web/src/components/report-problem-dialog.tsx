"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import * as Sentry from "@sentry/nextjs";
import { CheckCircle2, ImagePlus, Loader2, X } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CharacterCounter } from "@/components/ui/character-counter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/components/locale-provider";
import { getSupportContext } from "@/lib/analytics/posthog-browser";
import {
  ATTACHMENT_MAX_MB,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_TOPICS,
  diagnosticsLine,
  hasFeedbackErrors,
  readImageAttachment,
  validateFeedback,
  type FeedbackErrors,
  type FeedbackTopic,
} from "@/lib/feedback";
import { supportMailto, supportWhatsAppUrl } from "@/lib/support";
import { cn } from "@/lib/utils";

// The in-app "Report a problem" form — a first-party dialog, not Sentry's own
// rendered widget.
//
// It replaced `feedbackIntegration`'s dialog, which had three problems no
// amount of theming could reach:
//   1. Its copy was configured in Spanish at SDK-init time, so it was Spanish
//      for every user of an app whose default locale is `en` and which also
//      ships French. This form reads the same shared catalog as the rest of the
//      UI, so it follows the viewer's locale like everything else.
//   2. On a phone it stretched to the full viewport height, leaving a dead band
//      of several hundred pixels between the message box and the buttons. This
//      one is a bottom sheet that hugs its content.
//   3. Its screenshot button is desktop-only by construction — the SDK's own
//      `isScreenshotSupported()` returns false for every phone, since
//      `getDisplayMedia` does not exist there — which is exactly backwards from
//      where the reports come from. Here a screenshot is an ordinary file pick,
//      so the one already sitting in the camera roll works.
//
// The transport is unchanged: `Sentry.sendFeedback` posts to the same project
// as runtime errors, links the last error event, and carries the session replay.
type Status = "idle" | "sending" | "sent";

/** Ceiling for the message box's auto-grow, so a long report can never push the
 * footer out of the sheet. Past this the textarea scrolls on its own. */
const AUTOGROW_MAX_PX = 240;

/** The counter is noise at "3 / 2000". It appears once the cap is close enough
 * to be worth knowing about — which is also where CharacterCounter starts
 * changing tone. */
const COUNTER_VISIBLE_FROM = Math.floor(FEEDBACK_MESSAGE_MAX * 0.8);

/** `variant="link"` still carries the size scale's height and padding, which is
 * wrong for a Button that has to sit inside a line of running text. */
const INLINE_LINK = "h-auto p-0 text-xs font-normal";

function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length ? present.join(" ") : undefined;
}

export function ReportProblemDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const fieldId = useId();

  const [topic, setTopic] = useState<FeedbackTopic>("bug");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [identityFromSession, setIdentityFromSession] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [attachment, setAttachment] = useState<{
    filename: string;
    contentType: string;
    data: Uint8Array;
    previewUrl: string;
  } | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FeedbackErrors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [sendError, setSendError] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const sending = status === "sending";
  const sent = status === "sent";

  const messageErrorId = `${fieldId}-message-error`;
  const messageCountId = `${fieldId}-message-count`;
  const emailErrorId = `${fieldId}-email-error`;
  const emailHintId = `${fieldId}-email-hint`;
  const attachErrorId = `${fieldId}-attach-error`;

  // Seed the identity from the Sentry scope — the same place the old widget
  // read it from, written by <PostHogIdentify> on every authenticated layout.
  // Only on open, and only into a field still left at its default, so
  // re-opening a dialog whose draft survived a stray Escape never overwrites an
  // edit the user made.
  useEffect(() => {
    if (!open) return;
    const user = Sentry.getCurrentScope().getUser();
    const scopeEmail = typeof user?.email === "string" ? user.email : "";
    const scopeName = typeof user?.username === "string" ? user.username : "";
    setEmail((current) => current || scopeEmail);
    setName((current) => current || scopeName);
    if (scopeEmail) setIdentityFromSession(true);
  }, [open]);

  // Grow the message box with its content rather than making a long report
  // scroll inside four visible lines.
  useEffect(() => {
    const el = messageRef.current;
    if (!el || !open || sent) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) {
      el.style.height = `${Math.min(el.scrollHeight, AUTOGROW_MAX_PX)}px`;
    }
  }, [message, open, sent]);

  // The screenshot preview's object URL is revoked as soon as it is replaced or
  // the dialog goes away.
  useEffect(() => {
    const url = attachment?.previewUrl;
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [attachment?.previewUrl]);

  useEffect(() => {
    if (sent) doneRef.current?.focus();
  }, [sent]);

  const reset = useCallback(() => {
    setTopic("bug");
    setMessage("");
    setAttachment(null);
    setAttachError(null);
    setErrors({});
    setSendError(false);
    setStatus("idle");
    setEditingIdentity(false);
  }, []);

  // A half-written report survives an accidental dismiss — the draft is only
  // cleared once it has actually been sent. Closing mid-send is refused
  // outright rather than leaving a request in flight with no UI attached to it.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && sending) return;
      if (!next && sent) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset, sending, sent],
  );

  async function handlePickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear the input so removing a file and picking the same one again fires.
    event.target.value = "";
    if (!file) return;
    const result = await readImageAttachment(file);
    if (!result.ok) {
      setAttachment(null);
      setAttachError(t(result.error, result.vars));
      return;
    }
    setAttachError(null);
    setAttachment({
      filename: result.filename,
      contentType: result.contentType,
      data: result.data,
      previewUrl: URL.createObjectURL(file),
    });
  }

  function openWhatsApp() {
    const { distinctId, replayUrl } = getSupportContext();
    const url = supportWhatsAppUrl({
      page: typeof window !== "undefined" ? window.location.href : undefined,
      userId: distinctId,
      replayUrl,
    });
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;

    const nextErrors = validateFeedback({ message, email });
    setErrors(nextErrors);
    if (hasFeedbackErrors(nextErrors)) {
      if (nextErrors.message) {
        messageRef.current?.focus();
      } else {
        // The email may be behind the "Sending as …" summary; open it so the
        // field the error is about is actually on screen before focusing it.
        setEditingIdentity(true);
        requestAnimationFrame(() => emailRef.current?.focus());
      }
      return;
    }

    setSendError(false);
    setStatus("sending");

    const trimmed = message.trim();
    const details = typeof window !== "undefined" ? diagnosticsLine(window) : "";
    const body = details ? `${trimmed}\n\n---\n${details}` : trimmed;

    // No Sentry client (a deploy without NEXT_PUBLIC_SENTRY_DSN) means the
    // report has nowhere to go — hand it to the mail client rather than drop
    // it, which is what the old button did by rendering a dead menu entry.
    if (!Sentry.getClient()) {
      window.location.href = supportMailto(t("common.reportProblem"), body);
      setStatus("idle");
      handleOpenChange(false);
      return;
    }

    try {
      await Sentry.sendFeedback(
        {
          message: body,
          name: name.trim() || undefined,
          email: email.trim() || undefined,
          tags: { feedback_topic: topic },
          associatedEventId: Sentry.lastEventId(),
        },
        {
          includeReplay: true,
          ...(attachment
            ? {
                attachments: [
                  {
                    filename: attachment.filename,
                    contentType: attachment.contentType,
                    data: attachment.data,
                  },
                ],
              }
            : {}),
        },
      );
      setStatus("sent");
    } catch {
      setSendError(true);
      setStatus("idle");
    }
  }

  const whatsAppConfigured = Boolean(supportWhatsAppUrl({}));
  const showCounter = message.length >= COUNTER_VISIBLE_FROM;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={contentRef}
        placement="sheet"
        tabIndex={-1}
        className="sm:max-w-md"
        // Focus the dialog itself rather than its first field: auto-focusing the
        // textarea raises the phone keyboard over the form the moment it opens,
        // before the user has read what it is asking for.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (sending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (sending) event.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{sent ? t("feedback.thankYou") : t("common.reportProblem")}</DialogTitle>
          <DialogDescription>
            {sent ? t("feedback.received") : t("feedback.description")}
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="flex flex-col gap-6">
            {/* The dialog's accessible name is announced on open, not on this
                change of heading — so the outcome gets its own live region. */}
            <p role="status" className="sr-only">
              {t("feedback.received")}
            </p>
            <div className="flex justify-center py-2">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success-bg text-success">
                <CheckCircle2 className="h-7 w-7" aria-hidden />
              </span>
            </div>
            <DialogFooter className="shrink-0">
              <Button
                ref={doneRef}
                type="button"
                variant="secondary"
                onClick={() => handleOpenChange(false)}
              >
                {t("feedback.close")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            aria-busy={sending}
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            {/* The scroll lives here, not on the dialog, so the title, the close
                button and the actions stay put while a long report scrolls. The
                negative margin keeps focus rings from being clipped by it. */}
            <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
              <fieldset className="flex flex-col gap-2" disabled={sending}>
                <legend className="text-sm font-medium leading-none">
                  {t("feedback.topicLabel")}
                </legend>
                <div className="flex flex-wrap gap-2 pt-1">
                  {FEEDBACK_TOPICS.map((option) => (
                    <label key={option.id} className="cursor-pointer">
                      <input
                        type="radio"
                        name={`${fieldId}-topic`}
                        value={option.id}
                        checked={topic === option.id}
                        onChange={() => setTopic(option.id)}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                          "peer-checked:border-primary peer-checked:bg-primary/10 peer-checked:font-medium peer-checked:text-foreground",
                          "peer-focus-visible:ring-3 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
                          "inline-flex h-8 select-none items-center rounded-full border px-3 text-sm transition-colors",
                        )}
                      >
                        {t(option.labelKey)}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${fieldId}-message`}>{t("feedback.messageLabel")}</Label>
                <Textarea
                  id={`${fieldId}-message`}
                  ref={messageRef}
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value.slice(0, FEEDBACK_MESSAGE_MAX));
                    if (errors.message) setErrors((prev) => ({ ...prev, message: undefined }));
                  }}
                  placeholder={t("feedback.placeholder")}
                  maxLength={FEEDBACK_MESSAGE_MAX}
                  rows={3}
                  disabled={sending}
                  invalid={Boolean(errors.message)}
                  aria-describedby={describedBy(
                    showCounter && messageCountId,
                    errors.message && messageErrorId,
                  )}
                  className="resize-none"
                />
                {(errors.message || showCounter) && (
                  <div className="flex items-start justify-between gap-3">
                    <FieldError
                      id={messageErrorId}
                      message={errors.message ? t(errors.message) : undefined}
                    />
                    {showCounter && (
                      <CharacterCounter
                        id={messageCountId}
                        length={message.length}
                        max={FEEDBACK_MESSAGE_MAX}
                        className="ml-auto shrink-0"
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={sending}
                    onClick={() => fileRef.current?.click()}
                  >
                    <ImagePlus className="h-4 w-4" aria-hidden />
                    {t("feedback.attachLabel")}
                  </Button>
                  {!attachment && (
                    <span className="text-xs text-muted-foreground">
                      {t("feedback.attachHint", { max: ATTACHMENT_MAX_MB })}
                    </span>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handlePickFile}
                />
                {attachment && (
                  <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not a remote asset next/image can optimise */}
                    <img
                      src={attachment.previewUrl}
                      alt=""
                      className="h-10 w-10 rounded border border-border object-cover"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs">{attachment.filename}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setAttachment(null)}
                      disabled={sending}
                      aria-label={t("feedback.attachRemove", { filename: attachment.filename })}
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                )}
                <FieldError id={attachErrorId} message={attachError ?? undefined} />
              </div>

              {/* Who it comes from and what rides along with it: both are fine
                  print about the report rather than fields to fill in, so they
                  read as one block at the foot of the form. */}
              <div className="flex flex-col gap-2">
                {identityFromSession && !editingIdentity ? (
                  <p className="text-xs text-muted-foreground">
                    {t("feedback.sendingAs", { email })}{" "}
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => setEditingIdentity(true)}
                      className={INLINE_LINK}
                    >
                      {t("feedback.editDetails")}
                    </Button>
                  </p>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${fieldId}-name`}>{t("common.name")}</Label>
                      <Input
                        id={`${fieldId}-name`}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder={t("feedback.namePlaceholder")}
                        autoComplete="name"
                        disabled={sending}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${fieldId}-email`}>{t("common.email")}</Label>
                      <Input
                        id={`${fieldId}-email`}
                        ref={emailRef}
                        type="email"
                        inputMode="email"
                        value={email}
                        onChange={(event) => {
                          setEmail(event.target.value);
                          if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
                        }}
                        placeholder={t("feedback.emailPlaceholder")}
                        autoComplete="email"
                        disabled={sending}
                        invalid={Boolean(errors.email)}
                        aria-describedby={describedBy(emailHintId, errors.email && emailErrorId)}
                      />
                      <p id={emailHintId} className="text-xs text-muted-foreground">
                        {t("feedback.emailHint")}
                      </p>
                      <FieldError
                        id={emailErrorId}
                        message={errors.email ? t(errors.email) : undefined}
                      />
                    </div>
                  </div>
                )}

                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("feedback.diagnosticsNote")}
                </p>
              </div>

              {sendError && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{t("feedback.failed")}</AlertDescription>
                </Alert>
              )}
            </div>

            <div className="shrink-0">
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={sending}
                >
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={sending}>
                  {sending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {sending ? t("feedback.sending") : t("feedback.submit")}
                </Button>
              </DialogFooter>

              {whatsAppConfigured && (
                <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  {t("feedback.orReachUs")}{" "}
                  <Button
                    type="button"
                    variant="link"
                    onClick={openWhatsApp}
                    className={INLINE_LINK}
                  >
                    {t("common.chatOnWhatsApp")}
                  </Button>
                </p>
              )}
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
