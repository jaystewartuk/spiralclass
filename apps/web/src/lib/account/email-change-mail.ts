import { serverEnv } from "@/lib/env";
import { getEmailClient } from "@/lib/email";
import { renderBrandedEmailHtml } from "@/lib/email/html-shell";
import { SUPPORT_EMAIL } from "@/lib/support";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";

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
  const en = input.locale === "en";
  const heading = en ? "Your sign-in email changed" : "Tu correo de acceso cambió";
  const subject = en
    ? "Your SpiralClass sign-in email was changed"
    : "Tu correo de acceso a SpiralClass cambió";
  const intro = en
    ? `Your SpiralClass account's sign-in email is now ${input.newEmail}. Future sign-in links and notifications go there.`
    : `El correo de acceso de tu cuenta de SpiralClass ahora es ${input.newEmail}. Tus enlaces de acceso y avisos llegarán ahí.`;
  const googleNote = en
    ? "As part of this change, any Google account previously connected to sign in was disconnected, and any other signed-in devices were signed out. You can reconnect Google under the new address from Account settings."
    : "Como parte de este cambio, desconectamos cualquier cuenta de Google que estuviera conectada para iniciar sesión, y cerramos la sesión en cualquier otro dispositivo conectado. Puedes volver a conectar Google con tu nueva cuenta desde Configuración de la cuenta.";
  const warn = en
    ? `If you didn't make this change, write to us right away at ${SUPPORT_EMAIL}.`
    : `Si tú no hiciste este cambio, escríbenos de inmediato a ${SUPPORT_EMAIL}.`;

  const paragraphs = input.disconnectedGoogle ? [intro, googleNote, warn] : [intro, warn];

  const html = renderBrandedEmailHtml(
    { preheader: heading, heading, paragraphs },
    { languageCode: en ? "en" : "es_MX", appUrl: serverEnv().APP_URL },
  );
  const body = paragraphs.join("\n\n");

  const res = await getEmailClient().send({ to: input.to, subject, body, html });
  if (!res.ok) {
    log.warn("changed-notice send failed", { error: res.error });
    throw new Error("email-change-send-failed");
  }
}
