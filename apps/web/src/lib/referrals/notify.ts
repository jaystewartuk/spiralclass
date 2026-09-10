import { getEmailClient } from "@/lib/email";
import { renderBrandedEmailHtml } from "@/lib/email/html-shell";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";
import { usesEnglishCopy } from "@spiralclass/shared";

const log = logger({ surface: "referrals" });

// Transactional "your referral earned you a reward" email to the referrer.
// Sent directly (like the email-change / lead notices) rather than through the
// preference-gated notification dispatcher — this is a one-off student-facing
// transactional message. Caller gates on the student's email opt-in.
export async function notifyReferrerReward(input: {
  to: string;
  studentName: string;
  teacherName: string;
  rewardCode: string;
  rewardLabel: string;
  expiresAt: Date | null;
  locale: AppLocale;
}): Promise<void> {
  const en = usesEnglishCopy(input.locale);
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const portalUrl = `${appUrl}/my-classes`;

  const heading = en
    ? "Your referral earned you a reward"
    : "Tu recomendación te ganó una recompensa";
  const subject = en
    ? `You earned ${input.rewardLabel} off with ${input.teacherName}`
    : `Ganaste ${input.rewardLabel} de descuento con ${input.teacherName}`;
  const intro = en
    ? `Someone you referred just booked with ${input.teacherName} — thank you! Here's ${input.rewardLabel} off your next package.`
    : `Alguien que recomendaste acaba de reservar con ${input.teacherName} — ¡gracias! Aquí tienes ${input.rewardLabel} de descuento en tu próximo paquete.`;
  const codeLine = en ? `Your code: ${input.rewardCode}` : `Tu código: ${input.rewardCode}`;
  const expiryLine = input.expiresAt
    ? en
      ? `Use it before ${input.expiresAt.toISOString().slice(0, 10)}.`
      : `Úsalo antes del ${input.expiresAt.toISOString().slice(0, 10)}.`
    : null;
  const cta = en ? "Book your next classes" : "Reserva tus próximas clases";

  const paragraphs = [intro, codeLine, ...(expiryLine ? [expiryLine] : [])];
  const html = renderBrandedEmailHtml(
    { preheader: codeLine, heading, paragraphs, cta: { label: cta, url: portalUrl } },
    { languageCode: en ? "en" : "es_MX", appUrl },
  );
  const body = `${intro}\n\n${codeLine}${expiryLine ? `\n${expiryLine}` : ""}\n\n${cta}: ${portalUrl}`;

  const res = await getEmailClient().send({ to: input.to, subject, body, html });
  if (!res.ok) log.warn("referrer reward notify failed", { error: res.error });
}
