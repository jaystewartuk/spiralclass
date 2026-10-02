import { getEmailClient } from "@/lib/email";
import { renderBrandedEmailHtml } from "@/lib/email/html-shell";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";
import { createT, localeToLanguageCode } from "@spiralclass/shared";

const log = logger({ surface: "leads" });

// Transactional "new lead" alert to the teacher. This is a teacher-facing ops
// email (not a student lifecycle notification), so — like the email-change and
// account-disabled notices — it's sent directly via the email client rather
// than routed through the preference-gated student dispatcher. The teacher's
// own sign-in email is the recipient and `replyTo` is the lead's address so she
// can reply straight from her inbox.
export async function notifyTeacherOfLead(input: {
  to: string;
  teacherName: string;
  bookingSlug: string;
  locale: AppLocale;
  lead: { name: string; email: string; phone: string | null; message: string | null };
}): Promise<void> {
  const t = createT(input.locale);
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const leadsUrl = `${appUrl}/dashboard/leads`;

  const heading = t("email.leadAlert.heading");
  const subject = t("email.leadAlert.subject", { name: input.lead.name });
  const intro = t("email.leadAlert.intro", { name: input.lead.name });

  // Contact lines, spoken plainly so they read well in both the text and HTML
  // bodies. Phone/message are only included when present.
  const contactLabel = t("common.email");
  const lines = [t("email.labelledValue", { label: contactLabel, value: input.lead.email })];
  if (input.lead.phone)
    lines.push(
      t("email.labelledValue", { label: t("email.leadAlert.phoneLabel"), value: input.lead.phone }),
    );
  if (input.lead.message) {
    lines.push(
      t("email.labelledValue", {
        label: t("email.leadAlert.messageLabel"),
        value: input.lead.message,
      }),
    );
  }
  const ctaLabel = t("email.leadAlert.ctaLabel");

  const html = renderBrandedEmailHtml(
    {
      preheader: `${input.lead.name} · ${input.lead.email}`,
      heading,
      paragraphs: [intro, ...lines],
      cta: { label: ctaLabel, url: leadsUrl },
    },
    { languageCode: localeToLanguageCode(input.locale), appUrl },
  );
  const body = `${intro}\n\n${lines.join("\n")}\n\n${t("email.labelledValue", { label: ctaLabel, value: leadsUrl })}`;

  const res = await getEmailClient().send({
    to: input.to,
    subject,
    body,
    html,
    // Let the teacher reply straight to the prospective student.
    replyTo: input.lead.email,
  });
  if (!res.ok) {
    // Best-effort: a failed alert must never fail the visitor's submission.
    log.warn("lead notify failed", { error: res.error, slug: input.bookingSlug });
  }
}
