// Pure helpers behind the "Report a problem" dialog
// (components/report-problem-dialog.tsx). The dialog itself is a React
// component that talks to Sentry; everything here is framework-free and
// side-effect-free so the rules that decide whether a report is sendable —
// and what gets attached to it — are unit-testable without a DOM.

import type { StringKey } from "@spiralclass/shared";

/** Triage buckets offered as chips. `id` is what lands on the Sentry event as
 * the `feedback_topic` tag, so these strings are a stable wire value: renaming
 * one splits its history in Sentry's issue search. Add, don't rename. */
export const FEEDBACK_TOPICS = [
  { id: "bug", labelKey: "feedback.topic.bug" },
  { id: "billing", labelKey: "feedback.topic.billing" },
  { id: "confusing", labelKey: "feedback.topic.confusing" },
  { id: "idea", labelKey: "feedback.topic.idea" },
] as const satisfies readonly { id: string; labelKey: StringKey }[];

export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number]["id"];

/** Short enough that a one-line "it's broken" still asks for detail, long
 * enough not to nag someone who wrote a real sentence. Matches the mobile
 * FeedbackModal's threshold so both clients reject the same reports. */
export const FEEDBACK_MESSAGE_MIN = 10;
export const FEEDBACK_MESSAGE_MAX = 2000;

/** Screenshots land in a Sentry envelope, which has its own size ceiling well
 * above this. 5 MB is the product limit: it covers any phone screenshot while
 * keeping a mistaken 40 MB photo out of a form the user is watching. */
export const ATTACHMENT_MAX_MB = 5;
export const ATTACHMENT_MAX_BYTES = ATTACHMENT_MAX_MB * 1024 * 1024;

// Deliberately permissive: an email field's job here is to catch a typo like a
// missing "@", not to adjudicate RFC 5322. A wrongly-rejected address costs us
// the report; a wrongly-accepted one costs us a reply we could not send.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export type FeedbackErrors = {
  message?: StringKey;
  email?: StringKey;
};

/**
 * Validate the form. Returns catalog KEYS rather than rendered copy so the
 * rules stay locale-agnostic and the caller does the one `t()` lookup.
 *
 * Email is optional — an anonymous report is still worth having — but a
 * non-empty one has to be plausible, or the reply bounces silently.
 */
export function validateFeedback(input: { message: string; email: string }): FeedbackErrors {
  const errors: FeedbackErrors = {};
  if (input.message.trim().length < FEEDBACK_MESSAGE_MIN) {
    errors.message = "feedback.tooShort";
  }
  const email = input.email.trim();
  if (email && !isValidEmail(email)) {
    errors.email = "feedback.emailInvalid";
  }
  return errors;
}

export function hasFeedbackErrors(errors: FeedbackErrors): boolean {
  return Boolean(errors.message || errors.email);
}

/** Strip any directory component a browser might hand back, and keep the name
 * short enough to stay readable in Sentry's attachment list. */
export function attachmentFilename(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim();
  if (!base) return "screenshot";
  return base.length > 100 ? base.slice(-100) : base;
}

export type AttachmentResult =
  | { ok: true; filename: string; contentType: string; data: Uint8Array }
  | { ok: false; error: StringKey; vars?: Record<string, string | number> };

/**
 * Turn a picked file into a Sentry attachment, or an error key explaining why
 * it can't be one.
 *
 * A file input is used rather than Sentry's own screenshot button because that
 * button is desktop-only by construction — the SDK's `isScreenshotSupported()`
 * returns false for every phone, since `getDisplayMedia` doesn't exist there.
 * Phones are where the reports come from, and a phone screenshot is already in
 * the camera roll by the time someone opens this form.
 */
export async function readImageAttachment(file: File): Promise<AttachmentResult> {
  if (!file.type.startsWith("image/")) {
    return { ok: false, error: "feedback.attachInvalidType" };
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      error: "feedback.attachTooLarge",
      vars: { max: ATTACHMENT_MAX_MB },
    };
  }
  try {
    const buffer = await file.arrayBuffer();
    return {
      ok: true,
      filename: attachmentFilename(file.name),
      contentType: file.type,
      data: new Uint8Array(buffer),
    };
  } catch {
    return { ok: false, error: "feedback.attachReadFailed" };
  }
}

/**
 * A one-line summary of the browser the report came from, appended to the
 * message body. Sentry already records this on events it captures itself, but a
 * feedback item raised from a page that never errored carries no such context —
 * and "which browser?" is the first question every one of these reports gets.
 */
export function diagnosticsLine(win: {
  location?: { href?: string };
  navigator?: { userAgent?: string; language?: string };
  innerWidth?: number;
  innerHeight?: number;
}): string {
  const parts: string[] = [];
  if (win.location?.href) parts.push(win.location.href);
  if (win.innerWidth && win.innerHeight) parts.push(`${win.innerWidth}x${win.innerHeight}`);
  if (win.navigator?.language) parts.push(win.navigator.language);
  if (win.navigator?.userAgent) parts.push(win.navigator.userAgent);
  return parts.join(" · ");
}
