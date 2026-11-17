import type { Prisma } from "@prisma/client";
import { serverEnv } from "@/lib/env";
import { getEmailClient } from "@/lib/email";
import { renderBrandedEmailHtml, type EmailHtmlContent } from "@/lib/email/html-shell";
import { logger } from "@/lib/logger";
import { SUPPORT_EMAIL } from "@/lib/support";
import {
  localeToLanguageCode,
  type LanguageCode,
  createT,
  languageCodeToLocale,
} from "@spiralclass/shared";
import { benefitEmailLines } from "./benefits";
import { prisma } from "@/lib/prisma";
import { INVITATION_NOTIFICATION_TEMPLATE, INVITATION_PATH_PREFIX } from "./constants";

const log = logger({ surface: "invitations" });

// Absolute accept URL the email links to. `/i/<token>` resolves the same way
// everywhere, so one URL serves every surface.
export function invitationAcceptUrl(rawToken: string, appUrl = serverEnv().APP_URL): string {
  return `${appUrl.replace(/\/$/, "")}${INVITATION_PATH_PREFIX}/${encodeURIComponent(rawToken)}`;
}

// Which locale the invitation email renders in. The invite is the STUDENT's
// first touch from the product, so it follows the STUDENT's locale — not the
// teacher's, which is what this used to read. A teacher's own locale drives her
// dashboard and her own emails; it says nothing about what language her
// students read. An es teacher can (and does) have English-speaking
// students, so keying the invite off the teacher meant the only way to email a
// student in her own language was to flip the teacher's entire dashboard.
//
// Falls back to the teacher's locale when the roster row has none — better a
// teacher-shaped guess than an empty string reaching localeToLanguageCode().
export function invitationEmailLocale(
  studentLocale: string | null | undefined,
  teacherLocale: string,
): string {
  return studentLocale?.trim() || teacherLocale;
}

export type BuildInvitationEmailInput = {
  teacherName: string;
  studentName: string | null;
  acceptUrl: string;
  languageCode: LanguageCode;
  // Absolute https URL to the teacher's profile photo, or null.
  teacherAvatarUrl: string | null;
  // Whether the teacher has messaging enabled (adds the messaging benefit line).
  messagingEnabled: boolean;
};

export type BuiltEmail = { subject: string; body: string; html: string };

// Pure builder (no IO) so the copy + rendering is unit-testable. The subject
// names the teacher — the single most important trust signal for a cold invite.
export function buildInvitationEmail(input: BuildInvitationEmailInput): BuiltEmail {
  const t = createT(languageCodeToLocale(input.languageCode));
  const greetingName = input.studentName?.trim();
  const hello = greetingName
    ? t("email.invitation.hello", { greetingName })
    : t("email.invitation.hello2");

  const subject = t("email.invitation.subject", { teacherName: input.teacherName });
  const heading = t("invitation.accept.title");
  const preheader = t("email.invitation.preheader", { teacherName: input.teacherName });

  const intro = t("email.invitation.intro", { teacherName: input.teacherName });
  const closing = t("email.invitation.closing");

  const bullets = benefitEmailLines(input.messagingEnabled, t);

  const cta = {
    label: t("invitation.accept.acceptCta"),
    url: input.acceptUrl,
  };

  const html: EmailHtmlContent = {
    preheader,
    heading,
    paragraphs: [hello, intro, closing],
    bullets,
    cta,
    avatarUrl: input.teacherAvatarUrl ?? undefined,
  };

  const textBody = [
    hello,
    "",
    intro,
    ...bullets.map((b) => `• ${b}`),
    "",
    closing,
    "",
    t("email.labelledValue", { label: cta.label, value: input.acceptUrl }),
  ].join("\n");

  // Derive the email-logo origin from the (absolute) accept URL rather than
  // re-reading serverEnv here — keeps the builder pure/unit-testable.
  let appUrl: string | undefined;
  try {
    appUrl = new URL(input.acceptUrl).origin;
  } catch {
    appUrl = undefined;
  }

  return {
    subject,
    body: textBody,
    html: renderBrandedEmailHtml(html, {
      languageCode: input.languageCode,
      appUrl,
    }),
  };
}

// Who an invitation send belongs to, for the notifications row it leaves.
export type InvitationSendRecord = {
  teacherId: string;
  // The roster student the invitation provisioned — the row's recipient.
  studentId: string;
  invitationId: string;
};

// The one write this needs, stated structurally so a test double need not
// reimplement Prisma's overloaded client. The real client satisfies it.
export type InvitationRecordDb = {
  notification: {
    create(args: { data: Prisma.NotificationUncheckedCreateInput }): Promise<unknown>;
  };
};

// Build + send. The invite email is a one-off transactional send (like the
// auth OTP), NOT routed through the notification dispatcher: the recipient has
// no notification preferences yet (they aren't a platform user), and the invite
// must go out regardless of any later opt-out. Throws on send failure so
// the caller can surface it and NOT mark the invitation sent.
//
// After a successful send it writes a `notifications` row directly — never via
// enqueue or the dispatcher, so no preference gate can stop the invite — so
// the provider's delivery webhook can mark it delivered or bounced, and support
// sees it on /admin/notifications (issue #85). Without that row a bounce was
// dropped as `no-notification-row` and the invite read "sent" for ever.
export async function sendInvitationEmail(
  input: {
    to: string;
    teacherName: string;
    studentName: string | null;
    rawToken: string;
    locale: string;
    teacherAvatarUrl: string | null;
    messagingEnabled: boolean;
    record: InvitationSendRecord;
  },
  db: InvitationRecordDb = prisma,
): Promise<{ providerMessageId: string }> {
  const languageCode = localeToLanguageCode(input.locale);
  const email = buildInvitationEmail({
    teacherName: input.teacherName,
    studentName: input.studentName,
    acceptUrl: invitationAcceptUrl(input.rawToken),
    languageCode,
    teacherAvatarUrl: input.teacherAvatarUrl,
    messagingEnabled: input.messagingEnabled,
  });
  const res = await getEmailClient().send({
    to: input.to,
    subject: email.subject,
    body: email.body,
    html: email.html,
    replyTo: SUPPORT_EMAIL,
  });
  if (!res.ok) {
    log.error("invitation email send failed", undefined, { error: res.error });
    throw new Error("invitation-email-send-failed");
  }

  // Best-effort: the email has already gone out. Throwing here would make the
  // first-send caller discard an invitation the student is holding, or tell
  // the teacher a resend failed when it did not.
  try {
    await db.notification.create({
      data: {
        teacherId: input.record.teacherId,
        recipientType: "student",
        recipientId: input.record.studentId,
        channel: "email",
        templateName: INVITATION_NOTIFICATION_TEMPLATE,
        status: "sent",
        sentAt: new Date(),
        providerMessageId: res.providerMessageId,
        languageCode,
        metadata: { invitationId: input.record.invitationId },
      },
    });
  } catch (err) {
    log.error("invitation send record failed", err, {
      invitationId: input.record.invitationId,
    });
  }
  return { providerMessageId: res.providerMessageId };
}
