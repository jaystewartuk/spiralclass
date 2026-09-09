import { serverEnv } from "@/lib/env";
import { getEmailClient } from "@/lib/email";
import { renderBrandedEmailHtml, type EmailHtmlContent } from "@/lib/email/html-shell";
import { logger } from "@/lib/logger";
import { SUPPORT_EMAIL } from "@/lib/support";
import { localeToLanguageCode, type LanguageCode } from "@spiralclass/shared";
import { benefitEmailLines } from "./benefits";
import { INVITATION_PATH_PREFIX } from "./constants";

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
// students read. An es-MX teacher can (and does) have English-speaking
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
  const es = input.languageCode === "es_MX";
  const greetingName = input.studentName?.trim();
  const hello = greetingName
    ? es
      ? `Hola ${greetingName},`
      : `Hi ${greetingName},`
    : es
      ? "Hola,"
      : "Hi,";

  const subject = es
    ? `${input.teacherName} te invita a SpiralClass`
    : `${input.teacherName} invited you to SpiralClass`;
  const heading = es ? "Te invitaron a SpiralClass" : "You're invited to SpiralClass";
  const preheader = es
    ? `${input.teacherName} quiere organizar sus clases contigo en SpiralClass.`
    : `${input.teacherName} wants to manage your classes together on SpiralClass.`;

  const intro = es
    ? `${input.teacherName} usa SpiralClass para organizar sus clases y te invitó a unirte. Así tú y ${input.teacherName} tienen todo en un solo lugar:`
    : `${input.teacherName} uses SpiralClass to run their classes and invited you to join. It keeps everything you and ${input.teacherName} do in one place:`;
  const closing = es
    ? "Toca el botón para aceptar la invitación y crear tu cuenta — toma menos de un minuto."
    : "Tap the button to accept and set up your account — it takes less than a minute.";

  const bullets = benefitEmailLines(input.messagingEnabled, input.languageCode);

  const cta = {
    label: es ? "Aceptar invitación" : "Accept invitation",
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
    `${cta.label}: ${input.acceptUrl}`,
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

// Build + send. The invite email is a one-off transactional send (like the
// auth OTP), NOT routed through the notification dispatcher: the recipient has
// no notification preferences yet (they aren't a platform user), and the invite
// must go out regardless of any later opt-out. Throws on send failure so the
// caller can surface it and NOT mark the invitation sent.
export async function sendInvitationEmail(input: {
  to: string;
  teacherName: string;
  studentName: string | null;
  rawToken: string;
  locale: string;
  teacherAvatarUrl: string | null;
  messagingEnabled: boolean;
}): Promise<void> {
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
}
