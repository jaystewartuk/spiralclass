import { getEmailClient } from "@/lib/email";
import { renderBrandedEmailHtml } from "@/lib/email/html-shell";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";
import { createT, localeToLanguageCode } from "@spiralclass/shared";

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
  const t = createT(input.locale);
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const portalUrl = `${appUrl}/my-classes`;

  const heading = t("email.referralReward.heading");
  const subject = t("email.referralReward.subject", {
    rewardLabel: input.rewardLabel,
    teacherName: input.teacherName,
  });
  const intro = t("email.referralReward.intro", {
    teacherName: input.teacherName,
    rewardLabel: input.rewardLabel,
  });
  const codeLine = t("email.referralReward.codeLine", { rewardCode: input.rewardCode });
  const expiryLine = input.expiresAt
    ? t("email.referralReward.expiryLine", { date: input.expiresAt.toISOString().slice(0, 10) })
    : null;
  const cta = t("email.referralReward.cta");

  const paragraphs = [intro, codeLine, ...(expiryLine ? [expiryLine] : [])];
  const html = renderBrandedEmailHtml(
    { preheader: codeLine, heading, paragraphs, cta: { label: cta, url: portalUrl } },
    { languageCode: localeToLanguageCode(input.locale), appUrl },
  );
  const body = `${intro}\n\n${codeLine}${expiryLine ? `\n${expiryLine}` : ""}\n\n${t("email.labelledValue", { label: cta, value: portalUrl })}`;

  const res = await getEmailClient().send({ to: input.to, subject, body, html });
  if (!res.ok) log.warn("referrer reward notify failed", { error: res.error });
}
