import { getEmailClient } from "@/lib/email";
import { renderBrandedEmailHtml } from "@/lib/email/html-shell";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";

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
  const en = input.locale === "en";
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const leadsUrl = `${appUrl}/dashboard/leads`;

  const heading = en ? "New lead from your booking page" : "Nuevo interesado en tu página";
  const subject = en ? `New lead: ${input.lead.name}` : `Nuevo interesado: ${input.lead.name}`;
  const intro = en
    ? `${input.lead.name} reached out from your booking page and would like you to get in touch.`
    : `${input.lead.name} te escribió desde tu página de reservas y quiere que le contactes.`;

  // Contact lines, spoken plainly so they read well in both the text and HTML
  // bodies. Phone/message are only included when present.
  const contactLabel = en ? "Email" : "Correo";
  const lines = [`${contactLabel}: ${input.lead.email}`];
  if (input.lead.phone) lines.push(`${en ? "Phone" : "Teléfono"}: ${input.lead.phone}`);
  if (input.lead.message) {
    lines.push((en ? "Message: " : "Mensaje: ") + input.lead.message);
  }
  const ctaLabel = en ? "See your leads" : "Ver tus interesados";

  const html = renderBrandedEmailHtml(
    {
      preheader: `${input.lead.name} · ${input.lead.email}`,
      heading,
      paragraphs: [intro, ...lines],
      cta: { label: ctaLabel, url: leadsUrl },
    },
    { languageCode: en ? "en" : "es_MX", appUrl },
  );
  const body = `${intro}\n\n${lines.join("\n")}\n\n${ctaLabel}: ${leadsUrl}`;

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
