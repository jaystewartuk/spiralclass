import { serverEnv } from "@/lib/env";
import { getEmailClient } from "@/lib/email";
import { renderBrandedEmailHtml } from "@/lib/email/html-shell";
import { SUPPORT_EMAIL } from "@/lib/support";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";
import { createT, localeToLanguageCode } from "@spiralclass/shared";

// Shared transactional mail for the verified email-change flow. The
// confirmation CODE to the new address is sent by better-auth's own
// sendVerificationOTP callback (lib/auth/email-otp-delivery.ts) — this module
// only covers the security notice to the OLD address once the change lands,
// shared by both the student flow (lib/students/email-change.ts) and the
// teacher flow (lib/teachers/email-change.ts).

const log = logger({ surface: "email-change" });

// Security notice to the OLD address: detection, not confirmation
// (the single-confirmation model never requires a click from the old inbox).
export async function sendEmailChangedNotice(input: {
  to: string;
  newEmail: string;
  locale: AppLocale;
  // True when the change also disconnected a linked Google account (see
  // lib/auth/identity-change.ts) — folds in a line explaining that so the old
  // inbox's owner isn't confused when "Sign in with Google" stops working for
  // whatever Google account was linked before. Defaults to false so existing
  // callers/tests are unaffected.
  disconnectedGoogle?: boolean;
}): Promise<void> {
  const t = createT(input.locale);
  const heading = t("email.emailChanged.heading");
  const subject = t("email.emailChanged.subject");
  const intro = t("email.emailChanged.intro", { newEmail: input.newEmail });
  const googleNote = t("email.emailChanged.googleNote");
  const warn = t("email.emailChanged.warn", { supportEmail: SUPPORT_EMAIL });

  const paragraphs = input.disconnectedGoogle ? [intro, googleNote, warn] : [intro, warn];

  const html = renderBrandedEmailHtml(
    { preheader: heading, heading, paragraphs },
    { languageCode: localeToLanguageCode(input.locale), appUrl: serverEnv().APP_URL },
  );
  const body = paragraphs.join("\n\n");

  const res = await getEmailClient().send({ to: input.to, subject, body, html });
  if (!res.ok) {
    log.warn("changed-notice send failed", { error: res.error });
    throw new Error("email-change-send-failed");
  }
}
