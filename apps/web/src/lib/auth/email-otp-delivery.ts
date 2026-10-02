import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { getEmailClient, getEmailClientKind } from "@/lib/email";
import { renderBrandedEmailHtml } from "@/lib/email/html-shell";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";
import { createT, isAppLocale, DEFAULT_LOCALE, localeToLanguageCode } from "@spiralclass/shared";

const log = logger({ surface: "better-auth-email-otp" });

// D-40: deliver a better-auth email-OTP code via the existing Resend rail.
// **Code-only** — magic-link delivery is dropped (email-OTP only), so unlike the
// retired sendAuthMagicCode this carries no tappable link, just the code the
// user types into the requesting session (web or mobile). Wired into the
// better-auth instance's emailOTP.sendVerificationOTP.
export async function sendBetterAuthEmailOtp(input: {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}): Promise<void> {
  const locale = await resolveLocale(input.email);
  const t = createT(locale);
  const languageCode = localeToLanguageCode(locale);
  const isEmailChange = input.type === "change-email";
  const heading = isEmailChange ? t("email.otp.heading") : t("email.otp.heading2");
  const subject = isEmailChange ? t("email.otp.subject") : t("email.otp.subject2");
  const intro = isEmailChange ? t("email.otp.intro") : t("email.otp.intro2");
  const ignore = t("email.otp.ignore");

  const html = renderBrandedEmailHtml(
    { preheader: heading, heading, paragraphs: [intro, ignore], codeBlock: input.otp },
    { languageCode, appUrl: serverEnv().APP_URL },
  );
  const body = `${intro}\n\n${input.otp}\n\n${ignore}`;

  const res = await getEmailClient().send({ to: input.email, subject, body, html });
  if (!res.ok) {
    // Name the cause in the exception and in tags, not only in `extra`.
    // AGENDAPROFE-1V ran for seven weeks reading "better-auth email OTP send
    // failed" with `extra.error: "[Filtered]"` — Sentry's server-side scrubber
    // strips `extra` on this project while tags and the exception value come
    // through, so the one field that said WHY was the one field nobody could
    // read. `res.code` is the low-cardinality classification for exactly this
    // (see SendEmailFailure); the provider's full response body rides along as
    // `providerError` — named that way rather than `error` because
    // logger.error() overwrites its own `error` field with the exception's
    // message, which would drop the body from the log line entirely.
    const provider = getEmailClientKind() ?? "unknown";
    const err = new Error(`email-otp-send-failed: ${provider} ${res.code}`);
    log
      .child({ emailProvider: provider, emailFailure: res.code })
      .error("better-auth email OTP send failed", err, {
        providerError: res.error,
        retryable: res.retryable,
      });
    // Surface to the caller so the sign-in request fails loudly rather than
    // silently dropping the code (better-auth returns the error to the client).
    throw err;
  }
}

// better-auth's sendVerificationOTP callback carries no locale, so resolve it
// from the recipient's own row (teacher or student) by email; default to the
// platform default (Teacher.locale / Student.locale both default to "en").
// Best-effort — any lookup failure falls back to the same default.
async function resolveLocale(email: string): Promise<AppLocale> {
  try {
    const where = { email: { equals: email, mode: "insensitive" as const } };
    const [teacher, student] = await Promise.all([
      prisma.teacher.findFirst({ where, select: { locale: true } }),
      prisma.student.findFirst({ where, select: { locale: true } }),
    ]);
    const locale = teacher?.locale ?? student?.locale;
    return isAppLocale(locale) ? locale : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}
