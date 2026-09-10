import type { LanguageCode, TemplateName, TemplateVariables } from "@/lib/notifications/templates";
import { renderBrandedEmailHtml, type EmailHtmlContent } from "./html-shell";
import { cancellationPolicyPath } from "@/lib/terms-anchors";

// Email rendering for the 13 notifications, in es-MX + en. The text body
// is the WhatsApp fallback; the html body wraps the same content
// in the brand chrome (see html-shell.ts). URL suffixes are appended to
// APP_URL by the dispatcher before rendering. Confirmation and reminder
// templates have no action URL — the class video call happens on
// WhatsApp (the class detail page) so there's no meeting link to surface.

export type RenderedEmail = {
  subject: string;
  body: string;
  html: string;
};

export type RenderInput<T extends TemplateName> = {
  templateName: T;
  languageCode: LanguageCode;
  variables: TemplateVariables[T];
  // Pre-built absolute URL for the action button (already concatenated from
  // APP_URL + suffix), or null when the template has no action.
  actionUrl: string | null;
  // Pre-built absolute unsubscribe URL (HMAC-signed token under
  // `/r/email-uns/<token>`), appended to the body. Null in tests or when
  // the dispatcher cannot derive a teacher/student pair.
  unsubscribeUrl?: string | null;
  // Pre-built absolute "notification settings" URL (HMAC-signed token under
  // `/r/notif-settings/<token>`), appended to the body. Unlike
  // unsubscribeUrl this is sent on every email — teacher and student alike.
  notificationSettingsUrl?: string | null;
  // Pre-built absolute "Add to calendar" URL (a Google Calendar template
  // link), surfaced as a secondary link on the booking templates. Null when
  // the template has no class to add (most templates) or the data is missing.
  calendarUrl?: string | null;
  // App origin (e.g. "https://spiralclass.com") used to build the email
  // header logo URL. Required for the hosted PNG path; when absent the
  // header falls back to an inline SVG data URI.
  appUrl?: string;
};

type TemplateRender = {
  subject: string;
  textBody: string;
  html: EmailHtmlContent;
};

export function renderEmail<T extends TemplateName>(input: RenderInput<T>): RenderedEmail {
  const rendered = buildTemplate(input);
  let body = rendered.textBody;
  const footerLines = [
    input.notificationSettingsUrl
      ? notificationSettingsLine(input.languageCode, input.notificationSettingsUrl)
      : null,
    input.unsubscribeUrl ? footerLine(input.languageCode, input.unsubscribeUrl) : null,
  ].filter((line): line is string => line !== null);
  if (footerLines.length > 0) {
    body = `${body}\n\n—\n${footerLines.join("\n")}`;
  }
  const html = renderBrandedEmailHtml(rendered.html, {
    languageCode: input.languageCode,
    unsubscribeUrl: input.unsubscribeUrl ?? null,
    notificationSettingsUrl: input.notificationSettingsUrl ?? null,
    appUrl: input.appUrl,
  });
  return { subject: rendered.subject, body, html };
}

function footerLine(languageCode: LanguageCode, unsubscribeUrl: string): string {
  return languageCode === "es_MX"
    ? `Para dejar de recibir correos: ${unsubscribeUrl}`
    : `To stop receiving emails: ${unsubscribeUrl}`;
}

function notificationSettingsLine(
  languageCode: LanguageCode,
  notificationSettingsUrl: string,
): string {
  return languageCode === "es_MX"
    ? `Configurar notificaciones: ${notificationSettingsUrl}`
    : `Manage notification settings: ${notificationSettingsUrl}`;
}

// Deep link to the cancellation policy on /terms. Recipients could do nothing
// with the internal spec section number these emails used to print, so a
// deduction email cites the policy by name and links here instead. That
// judgement is why no citation survives anywhere a reader can see. Falls back
// to the production
// origin when the dispatcher hasn't wired appUrl (tests).
function cancellationPolicyUrl(appUrl: string | undefined, es: boolean): string {
  const origin = (appUrl ?? "https://spiralclass.com").replace(/\/$/, "");
  return `${origin}${cancellationPolicyPath(es)}`;
}

// Teacher-mirror note when the student's own notice was suppressed by the
// archived-pairing gate ("dar de baja"). The suppression itself is silent
// by design; the teacher email is where the gap should be visible.
function archivedSuppressionNote(studentName: string, es: boolean): string {
  return es
    ? `Nota: ${studentName} no recibió ningún aviso de esta cancelación porque está dado de baja en tu listado. Reactívalo desde su ficha si quieres que vuelva a recibir avisos.`
    : `Note: ${studentName} did not receive a notice for this cancellation because they're archived on your roster. Reactivate them from their profile if you want them to get notices again.`;
}

// The medium line on booking emails. When the dispatcher supplies a call URL
// (via actionUrl — set only when the platform call is available for this
// booking, D-16), the email points the student at the in-class video call with a
// button; otherwise it keeps the original "we meet on WhatsApp" copy. `textLink`
// puts the URL in the plain-text body too, alongside the html cta.
function meetingMedium(
  es: boolean,
  callUrl: string | null,
): { sentence: string; cta?: { label: string; url: string }; textLink: string } {
  if (callUrl) {
    const label = es ? "Entrar a la videollamada" : "Join video call";
    return {
      sentence: es
        ? "Entra a la videollamada a la hora de tu clase."
        : "Join the video call at class time.",
      cta: { label, url: callUrl },
      textLink: `\n\n${label}: ${callUrl}`,
    };
  }
  return {
    sentence: es
      ? "Nos conectamos por WhatsApp a esa hora."
      : "We'll meet on WhatsApp at that time.",
    textLink: "",
  };
}

function buildTemplate<T extends TemplateName>(input: RenderInput<T>): TemplateRender {
  const es = input.languageCode === "es_MX";
  // "Add to calendar" secondary link, attached to the booking templates when
  // the dispatcher supplies a calendar URL (lib/calendar). No-op otherwise.
  const calLabel = es ? "Agregar a calendario" : "Add to calendar";
  const calLine = input.calendarUrl ? `\n\n${calLabel}: ${input.calendarUrl}` : "";
  const calLink = input.calendarUrl ? { label: calLabel, url: input.calendarUrl } : undefined;
  // Meeting medium for the booking templates (WhatsApp by default, video call
  // when available). `cta` is undefined when there's no call, so booking emails
  // stay button-less in that case.
  const meet = meetingMedium(es, input.actionUrl);
  switch (input.templateName) {
    case "booking_confirmation": {
      const v = input.variables as TemplateVariables["booking_confirmation"];
      return es
        ? {
            subject: `Tu clase con ${v.teacherName} está confirmada`,
            textBody: `Hola, soy ${v.teacherName}. Tu clase del ${v.classDateTime} está confirmada. Te quedan ${v.classesRemaining} clases.\n\n${meet.sentence}${meet.textLink}${calLine}`,
            html: {
              preheader: `${v.classDateTime} · te quedan ${v.classesRemaining} clases`,
              heading: "Clase confirmada",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Tu clase del ${v.classDateTime} está confirmada. Te quedan ${v.classesRemaining} clases.`,
                meet.sentence,
              ],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          }
        : {
            subject: `Your class with ${v.teacherName} is confirmed`,
            textBody: `Hi, I'm ${v.teacherName}. Your class on ${v.classDateTime} is confirmed. You have ${v.classesRemaining} classes left.\n\n${meet.sentence}${meet.textLink}${calLine}`,
            html: {
              preheader: `${v.classDateTime} · ${v.classesRemaining} classes left`,
              heading: "Class confirmed",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Your class on ${v.classDateTime} is confirmed. You have ${v.classesRemaining} classes left.`,
                meet.sentence,
              ],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          };
    }
    case "reminder_24h": {
      const v = input.variables as TemplateVariables["reminder_24h"];
      return es
        ? {
            subject: `Recordatorio: clase mañana con ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Te recuerdo nuestra clase mañana, ${v.classDateTime}.\n\n${meet.sentence}${meet.textLink}${calLine}`,
            html: {
              preheader: `Clase mañana — ${v.classDateTime}`,
              heading: "Tu clase es mañana",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Te recuerdo nuestra clase mañana, ${v.classDateTime}.`,
                meet.sentence,
              ],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          }
        : {
            subject: `Reminder: class tomorrow with ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. Reminder for our class tomorrow, ${v.classDateTime}.\n\n${meet.sentence}${meet.textLink}${calLine}`,
            html: {
              preheader: `Class tomorrow — ${v.classDateTime}`,
              heading: "Your class is tomorrow",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Reminder for our class tomorrow, ${v.classDateTime}.`,
                meet.sentence,
              ],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          };
    }
    case "reminder_1h": {
      const v = input.variables as TemplateVariables["reminder_1h"];
      // 1h embeds the medium inline ("…, por WhatsApp."). With a call link we
      // split it into a plain greeting + the call sentence + button; without
      // one we keep the original single-sentence copy verbatim.
      const esGreeting1h = input.actionUrl
        ? `Hola, soy ${v.teacherName}. Nos vemos en 1 hora, ${v.classDateTime}.`
        : `Hola, soy ${v.teacherName}. Nos vemos en 1 hora, ${v.classDateTime}, por WhatsApp.`;
      const enGreeting1h = input.actionUrl
        ? `Hi, I'm ${v.teacherName}. See you in 1 hour, ${v.classDateTime}.`
        : `Hi, I'm ${v.teacherName}. See you in 1 hour, ${v.classDateTime}, on WhatsApp.`;
      const tail1h = input.actionUrl ? ` ${meet.sentence}${meet.textLink}` : "";
      return es
        ? {
            subject: `Tu clase con ${v.teacherName} empieza en 1 hora`,
            textBody: `${esGreeting1h}${tail1h}${calLine}`,
            html: {
              preheader: `En 1 hora — ${v.classDateTime}`,
              heading: "Tu clase empieza en 1 hora",
              paragraphs: input.actionUrl ? [esGreeting1h, meet.sentence] : [esGreeting1h],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          }
        : {
            subject: `Class with ${v.teacherName} starts in 1 hour`,
            textBody: `${enGreeting1h}${tail1h}${calLine}`,
            html: {
              preheader: `In 1 hour — ${v.classDateTime}`,
              heading: "Your class starts in 1 hour",
              paragraphs: input.actionUrl ? [enGreeting1h, meet.sentence] : [enGreeting1h],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          };
    }
    case "reminder_15m": {
      const v = input.variables as TemplateVariables["reminder_15m"];
      const esGreeting5m = input.actionUrl
        ? `Hola, soy ${v.teacherName}. Tu clase empieza en 15 minutos, ${v.classDateTime}.`
        : `Hola, soy ${v.teacherName}. Tu clase empieza en 15 minutos, ${v.classDateTime}, por WhatsApp.`;
      const enGreeting5m = input.actionUrl
        ? `Hi, I'm ${v.teacherName}. Your class starts in 15 minutes, ${v.classDateTime}.`
        : `Hi, I'm ${v.teacherName}. Your class starts in 15 minutes, ${v.classDateTime}, on WhatsApp.`;
      const tail5m = input.actionUrl ? ` ${meet.sentence}${meet.textLink}` : "";
      return es
        ? {
            subject: `Tu clase con ${v.teacherName} empieza en 15 minutos`,
            textBody: `${esGreeting5m}${tail5m}`,
            html: {
              preheader: `En 15 minutos — ${v.classDateTime}`,
              heading: "Tu clase empieza en 15 minutos",
              paragraphs: input.actionUrl ? [esGreeting5m, meet.sentence] : [esGreeting5m],
              cta: meet.cta,
            },
          }
        : {
            subject: `Class with ${v.teacherName} starts in 15 minutes`,
            textBody: `${enGreeting5m}${tail5m}`,
            html: {
              preheader: `In 15 minutes — ${v.classDateTime}`,
              heading: "Your class starts in 15 minutes",
              paragraphs: input.actionUrl ? [enGreeting5m, meet.sentence] : [enGreeting5m],
              cta: meet.cta,
            },
          };
    }
    // Teacher-recipient reminders. Teacher-voiced copy that names the student.
    // Unlike the student reminders these only surface the meeting line/button
    // when a real video-call link is available — no stale "on WhatsApp" copy.
    case "reminder_24h_teacher": {
      const v = input.variables as TemplateVariables["reminder_24h_teacher"];
      const meetParas = input.actionUrl ? [meet.sentence] : [];
      const meetTail = input.actionUrl ? `\n\n${meet.sentence}${meet.textLink}` : "";
      return es
        ? {
            subject: `Recordatorio: clase mañana con ${v.studentName}`,
            textBody: `Te recuerdo tu clase con ${v.studentName} mañana, ${v.classDateTime}.${meetTail}${calLine}`,
            html: {
              preheader: `Clase mañana — ${v.classDateTime}`,
              heading: "Tu clase es mañana",
              paragraphs: [
                `Te recuerdo tu clase con ${v.studentName} mañana, ${v.classDateTime}.`,
                ...meetParas,
              ],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          }
        : {
            subject: `Reminder: class tomorrow with ${v.studentName}`,
            textBody: `Reminder: your class with ${v.studentName} is tomorrow, ${v.classDateTime}.${meetTail}${calLine}`,
            html: {
              preheader: `Class tomorrow — ${v.classDateTime}`,
              heading: "Your class is tomorrow",
              paragraphs: [
                `Reminder: your class with ${v.studentName} is tomorrow, ${v.classDateTime}.`,
                ...meetParas,
              ],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          };
    }
    case "reminder_1h_teacher": {
      const v = input.variables as TemplateVariables["reminder_1h_teacher"];
      const meetParas = input.actionUrl ? [meet.sentence] : [];
      const meetTail = input.actionUrl ? `\n\n${meet.sentence}${meet.textLink}` : "";
      return es
        ? {
            subject: `Tu clase con ${v.studentName} empieza en 1 hora`,
            textBody: `Tu clase con ${v.studentName} empieza en 1 hora, ${v.classDateTime}.${meetTail}${calLine}`,
            html: {
              preheader: `En 1 hora — ${v.classDateTime}`,
              heading: "Tu clase empieza en 1 hora",
              paragraphs: [
                `Tu clase con ${v.studentName} empieza en 1 hora, ${v.classDateTime}.`,
                ...meetParas,
              ],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          }
        : {
            subject: `Class with ${v.studentName} starts in 1 hour`,
            textBody: `Your class with ${v.studentName} starts in 1 hour, ${v.classDateTime}.${meetTail}${calLine}`,
            html: {
              preheader: `In 1 hour — ${v.classDateTime}`,
              heading: "Your class starts in 1 hour",
              paragraphs: [
                `Your class with ${v.studentName} starts in 1 hour, ${v.classDateTime}.`,
                ...meetParas,
              ],
              cta: meet.cta,
              secondaryLink: calLink,
            },
          };
    }
    case "reminder_15m_teacher": {
      const v = input.variables as TemplateVariables["reminder_15m_teacher"];
      const meetParas = input.actionUrl ? [meet.sentence] : [];
      const meetTail = input.actionUrl ? `\n\n${meet.sentence}${meet.textLink}` : "";
      return es
        ? {
            subject: `Tu clase con ${v.studentName} empieza en 15 minutos`,
            textBody: `Tu clase con ${v.studentName} empieza en 15 minutos, ${v.classDateTime}.${meetTail}`,
            html: {
              preheader: `En 15 minutos — ${v.classDateTime}`,
              heading: "Tu clase empieza en 15 minutos",
              paragraphs: [
                `Tu clase con ${v.studentName} empieza en 15 minutos, ${v.classDateTime}.`,
                ...meetParas,
              ],
              cta: meet.cta,
            },
          }
        : {
            subject: `Class with ${v.studentName} starts in 15 minutes`,
            textBody: `Your class with ${v.studentName} starts in 15 minutes, ${v.classDateTime}.${meetTail}`,
            html: {
              preheader: `In 15 minutes — ${v.classDateTime}`,
              heading: "Your class starts in 15 minutes",
              paragraphs: [
                `Your class with ${v.studentName} starts in 15 minutes, ${v.classDateTime}.`,
                ...meetParas,
              ],
              cta: meet.cta,
            },
          };
    }
    case "cancel_lt24h": {
      const v = input.variables as TemplateVariables["cancel_lt24h"];
      const policyUrl = cancellationPolicyUrl(input.appUrl, es);
      return es
        ? {
            subject: `Cancelación con menos de 24h — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Cancelaste la clase del ${v.originalDateTime} con menos de 24h, así que se descuenta del paquete según la política de cancelaciones.\n\nConsulta la política: ${policyUrl}`,
            html: {
              preheader: `Cancelación tardía · ${v.originalDateTime}`,
              heading: "Cancelación con menos de 24h",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Cancelaste la clase del ${v.originalDateTime} con menos de 24h, así que se descuenta del paquete según la política de cancelaciones.`,
              ],
              cta: { label: "Ver política de cancelaciones", url: policyUrl },
            },
          }
        : {
            subject: `Late cancellation — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. You canceled the ${v.originalDateTime} class with less than 24h notice, so it's deducted from your package per the cancellation policy.\n\nCancellation policy: ${policyUrl}`,
            html: {
              preheader: `Late cancellation · ${v.originalDateTime}`,
              heading: "Late cancellation (<24h)",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. You canceled the ${v.originalDateTime} class with less than 24h notice, so it's deducted from your package per the cancellation policy.`,
              ],
              cta: { label: "View cancellation policy", url: policyUrl },
            },
          };
    }
    case "cancel_gte24h_with_reschedule": {
      const v = input.variables as TemplateVariables["cancel_gte24h_with_reschedule"];
      return es
        ? {
            subject: `Reagenda tu clase — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Cancelaste la clase del ${v.originalDateTime} con anticipación. Puedes reagendar tu clase cuando quieras.\n\nReagenda: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Reagenda tu clase`,
              heading: "Reagenda tu clase",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Cancelaste la clase del ${v.originalDateTime} con anticipación. Puedes reagendar tu clase cuando quieras.`,
              ],
              cta: input.actionUrl ? { label: "Reagendar clase", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Reschedule your class — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. You canceled the ${v.originalDateTime} class on time. You can reschedule your class whenever you like.\n\nReschedule: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Reschedule your class`,
              heading: "Reschedule your class",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. You canceled the ${v.originalDateTime} class on time. You can reschedule your class whenever you like.`,
              ],
              cta: input.actionUrl
                ? { label: "Reschedule class", url: input.actionUrl }
                : undefined,
            },
          };
    }
    case "teacher_cancel": {
      const v = input.variables as TemplateVariables["teacher_cancel"];
      return es
        ? {
            subject: `Reagenda tu clase — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Tuve que cancelar la clase del ${v.originalDateTime}. La clase se restaura en tu paquete; reagendamos cuando puedas.\n\nReagenda: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Tu clase fue cancelada — reagendamos`,
              heading: "Tu clase fue cancelada",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Tuve que cancelar la clase del ${v.originalDateTime}.`,
                "La clase se restaura en tu paquete; reagendamos cuando puedas.",
              ],
              cta: input.actionUrl ? { label: "Reagendar clase", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Class canceled — please reschedule — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. I had to cancel the ${v.originalDateTime} class. The class is restored in your package; let's reschedule.\n\nReschedule: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Class canceled — let's reschedule`,
              heading: "Your class was canceled",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. I had to cancel the ${v.originalDateTime} class.`,
                "The class is restored in your package; let's reschedule.",
              ],
              cta: input.actionUrl
                ? { label: "Reschedule class", url: input.actionUrl }
                : undefined,
            },
          };
    }
    case "reschedule_confirm": {
      const v = input.variables as TemplateVariables["reschedule_confirm"];
      return es
        ? {
            subject: `Reagendado — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Cambié tu clase del ${v.oldDateTime} al ${v.newDateTime}.\n\nNos conectamos por WhatsApp a esa hora.`,
            html: {
              preheader: `Nueva fecha: ${v.newDateTime}`,
              heading: "Clase reagendada",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Cambié tu clase del ${v.oldDateTime} al ${v.newDateTime}.`,
                "Nos conectamos por WhatsApp a esa hora.",
              ],
            },
          }
        : {
            subject: `Rescheduled — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. Moved your class from ${v.oldDateTime} to ${v.newDateTime}.\n\nWe'll meet on WhatsApp at that time.`,
            html: {
              preheader: `New time: ${v.newDateTime}`,
              heading: "Class rescheduled",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Moved your class from ${v.oldDateTime} to ${v.newDateTime}.`,
                "We'll meet on WhatsApp at that time.",
              ],
            },
          };
    }
    case "payment_received": {
      const v = input.variables as TemplateVariables["payment_received"];
      return es
        ? {
            subject: `Pago recibido — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Recibí tu pago por ${v.packageName} (${v.amount}). Tu paquete ya está activo.\n\nEntra al portal: ${input.actionUrl ?? "(pendiente)"}`,
            html: {
              preheader: `${v.packageName} · ${v.amount}`,
              heading: "Pago recibido",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Recibí tu pago por ${v.packageName} (${v.amount}).`,
                "Tu paquete ya está activo.",
              ],
              cta: input.actionUrl ? { label: "Abrir mi portal", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Payment received — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. Got your payment for ${v.packageName} (${v.amount}). Your package is active.\n\nPortal: ${input.actionUrl ?? "(pending)"}`,
            html: {
              preheader: `${v.packageName} · ${v.amount}`,
              heading: "Payment received",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Got your payment for ${v.packageName} (${v.amount}).`,
                "Your package is active.",
              ],
              cta: input.actionUrl ? { label: "Open my portal", url: input.actionUrl } : undefined,
            },
          };
    }
    case "magic_link": {
      const v = input.variables as TemplateVariables["magic_link"];
      return es
        ? {
            subject: `Tu acceso a clases con ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Aquí está tu enlace para entrar (válido por ${v.expiryMinutes} minutos):\n\n${input.actionUrl ?? "(pendiente)"}`,
            html: {
              preheader: `Válido por ${v.expiryMinutes} minutos`,
              heading: "Tu acceso",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Aquí está tu enlace para entrar. Es válido por ${v.expiryMinutes} minutos.`,
              ],
              cta: input.actionUrl
                ? { label: "Entrar a mi cuenta", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `Your sign-in link with ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. Here's your sign-in link (valid for ${v.expiryMinutes} minutes):\n\n${input.actionUrl ?? "(pending)"}`,
            html: {
              preheader: `Valid for ${v.expiryMinutes} minutes`,
              heading: "Your sign-in link",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Here's your sign-in link. It's valid for ${v.expiryMinutes} minutes.`,
              ],
              cta: input.actionUrl ? { label: "Sign in", url: input.actionUrl } : undefined,
            },
          };
    }
    case "materials_send": {
      const v = input.variables as TemplateVariables["materials_send"];
      return es
        ? {
            subject: `Material para tu clase — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Te comparto el material para la clase del ${v.classDateTime}.\n\nDescarga: ${input.actionUrl ?? "(pendiente)"}`,
            html: {
              preheader: `Material para ${v.classDateTime}`,
              heading: "Material para tu clase",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Te comparto el material para la clase del ${v.classDateTime}.`,
              ],
              cta: input.actionUrl
                ? { label: "Descargar material", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `Class materials — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. Materials for the ${v.classDateTime} class.\n\nDownload: ${input.actionUrl ?? "(pending)"}`,
            html: {
              preheader: `Materials for ${v.classDateTime}`,
              heading: "Your class materials",
              paragraphs: [`Hi, I'm ${v.teacherName}. Materials for the ${v.classDateTime} class.`],
              cta: input.actionUrl
                ? { label: "Download materials", url: input.actionUrl }
                : undefined,
            },
          };
    }
    case "wise_marked_sent_student": {
      const v = input.variables as TemplateVariables["wise_marked_sent_student"];
      return es
        ? {
            subject: "Recibimos tu aviso de pago",
            textBody: `Hola, soy ${v.teacherName}. Gracias por avisar que enviaste tu transferencia Wise (referencia ${v.wiseReference}) por ${v.packageName}.\n\nEn cuanto la vea reflejada, confirmo el pago y tu paquete queda activo — te llega otro correo en ese momento.`,
            html: {
              preheader: `Referencia ${v.wiseReference} · ${v.packageName}`,
              heading: "Recibimos tu aviso de pago",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Gracias por avisar que enviaste tu transferencia Wise (referencia ${v.wiseReference}) por ${v.packageName}.`,
                "En cuanto la vea reflejada, confirmo el pago y tu paquete queda activo — te llega otro correo en ese momento.",
              ],
            },
          }
        : {
            subject: "We got your payment notice",
            textBody: `Hi, I'm ${v.teacherName}. Thanks for letting me know you sent your Wise transfer (reference ${v.wiseReference}) for ${v.packageName}.\n\nAs soon as it shows up I'll confirm the payment and your package goes active — you'll get another email then.`,
            html: {
              preheader: `Reference ${v.wiseReference} · ${v.packageName}`,
              heading: "We got your payment notice",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Thanks for letting me know you sent your Wise transfer (reference ${v.wiseReference}) for ${v.packageName}.`,
                "As soon as it shows up I'll confirm the payment and your package goes active — you'll get another email then.",
              ],
            },
          };
    }
    case "payment_received_teacher": {
      const v = input.variables as TemplateVariables["payment_received_teacher"];
      return es
        ? {
            subject: `Nueva venta — ${v.studentName} compró ${v.packageName}`,
            textBody: `Hola ${v.teacherName}, ${v.studentName} compró ${v.packageName} por ${v.amount} con tarjeta. El paquete ya está activo y el dinero va en camino a tu cuenta.\n\nVer el pago: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `${v.studentName} · ${v.packageName} · ${v.amount}`,
              heading: "Nueva venta",
              paragraphs: [
                `Hola ${v.teacherName}, ${v.studentName} compró ${v.packageName} por ${v.amount} con tarjeta.`,
                "El paquete ya está activo y el dinero va en camino a tu cuenta.",
              ],
              cta: input.actionUrl ? { label: "Ver el pago", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `New sale — ${v.studentName} bought ${v.packageName}`,
            textBody: `Hi ${v.teacherName}, ${v.studentName} bought ${v.packageName} for ${v.amount} by card. The package is already active and the money is on its way to your account.\n\nView payment: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `${v.studentName} · ${v.packageName} · ${v.amount}`,
              heading: "New sale",
              paragraphs: [
                `Hi ${v.teacherName}, ${v.studentName} bought ${v.packageName} for ${v.amount} by card.`,
                "The package is already active and the money is on its way to your account.",
              ],
              cta: input.actionUrl ? { label: "View payment", url: input.actionUrl } : undefined,
            },
          };
    }
    case "payment_pending_teacher": {
      const v = input.variables as TemplateVariables["payment_pending_teacher"];
      return es
        ? {
            subject: `Pago Wise pendiente — ${v.studentName}`,
            textBody: `Hola ${v.teacherName}, ${v.studentName} acaba de iniciar la compra de ${v.packageName} por ${v.amount} con Wise.\n\nReferencia: ${v.wiseReference}\n\nCuando recibas la transferencia en Wise, confírmala aquí: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount} · ${v.wiseReference}`,
              heading: "Pago Wise pendiente",
              paragraphs: [
                `Hola ${v.teacherName}, ${v.studentName} acaba de iniciar la compra de ${v.packageName} por ${v.amount} con Wise.`,
                `Referencia Wise: ${v.wiseReference}`,
                "Cuando recibas la transferencia en Wise, confírmala para activar el paquete.",
              ],
              cta: input.actionUrl ? { label: "Confirmar pago", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Wise payment pending — ${v.studentName}`,
            textBody: `Hi ${v.teacherName}, ${v.studentName} just started buying ${v.packageName} for ${v.amount} via Wise.\n\nReference: ${v.wiseReference}\n\nWhen the transfer lands in Wise, confirm it here: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount} · ${v.wiseReference}`,
              heading: "Wise payment pending",
              paragraphs: [
                `Hi ${v.teacherName}, ${v.studentName} just started buying ${v.packageName} for ${v.amount} via Wise.`,
                `Wise reference: ${v.wiseReference}`,
                "When the transfer lands in Wise, confirm it to activate the package.",
              ],
              cta: input.actionUrl ? { label: "Confirm payment", url: input.actionUrl } : undefined,
            },
          };
    }
    case "payment_marked_sent_teacher": {
      const v = input.variables as TemplateVariables["payment_marked_sent_teacher"];
      return es
        ? {
            subject: `${v.studentName} dice que ya envió el pago Wise`,
            textBody: `Hola ${v.teacherName}, ${v.studentName} marcó como enviada la transferencia de ${v.amount} por ${v.packageName}.\n\nReferencia: ${v.wiseReference}\n\nRevisa tu Wise y confirma la recepción para activar el paquete: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount} · ${v.wiseReference}`,
              heading: `${v.studentName} envió el pago`,
              paragraphs: [
                `Hola ${v.teacherName}, ${v.studentName} marcó como enviada la transferencia de ${v.amount} por ${v.packageName}.`,
                `Referencia Wise: ${v.wiseReference}`,
                "Revisa tu Wise y confirma la recepción para activar el paquete.",
              ],
              cta: input.actionUrl
                ? { label: "Confirmar recepción", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `${v.studentName} says the Wise transfer is on the way`,
            textBody: `Hi ${v.teacherName}, ${v.studentName} marked the ${v.amount} transfer for ${v.packageName} as sent.\n\nReference: ${v.wiseReference}\n\nCheck your Wise inbox and confirm receipt to activate the package: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount} · ${v.wiseReference}`,
              heading: `${v.studentName} sent the payment`,
              paragraphs: [
                `Hi ${v.teacherName}, ${v.studentName} marked the ${v.amount} transfer for ${v.packageName} as sent.`,
                `Wise reference: ${v.wiseReference}`,
                "Check your Wise inbox and confirm receipt to activate the package.",
              ],
              cta: input.actionUrl ? { label: "Confirm receipt", url: input.actionUrl } : undefined,
            },
          };
    }
    case "wise_confirm_reminder_teacher": {
      const v = input.variables as TemplateVariables["wise_confirm_reminder_teacher"];
      return es
        ? {
            subject: `Recordatorio: confirma el pago Wise de ${v.studentName}`,
            textBody: `Hola ${v.teacherName}, ${v.studentName} marcó como enviada la transferencia de ${v.amount} por ${v.packageName} y sigue sin confirmar. El paquete no se activa hasta que confirmes la recepción en tu Wise.\n\nReferencia: ${v.wiseReference}\n\nConfirmar: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount} · pendiente de confirmar`,
              heading: "Pago Wise pendiente de confirmar",
              paragraphs: [
                `Hola ${v.teacherName}, ${v.studentName} marcó como enviada la transferencia de ${v.amount} por ${v.packageName} y sigue sin confirmar.`,
                `Referencia Wise: ${v.wiseReference}`,
                "El paquete no se activa hasta que confirmes la recepción en tu Wise.",
              ],
              cta: input.actionUrl ? { label: "Confirmar pago", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Reminder: confirm ${v.studentName}'s Wise payment`,
            textBody: `Hi ${v.teacherName}, ${v.studentName} marked the ${v.amount} transfer for ${v.packageName} as sent and it's still unconfirmed. The package won't activate until you confirm receipt in your Wise.\n\nReference: ${v.wiseReference}\n\nConfirm: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount} · awaiting confirmation`,
              heading: "Wise payment awaiting confirmation",
              paragraphs: [
                `Hi ${v.teacherName}, ${v.studentName} marked the ${v.amount} transfer for ${v.packageName} as sent and it's still unconfirmed.`,
                `Wise reference: ${v.wiseReference}`,
                "The package won't activate until you confirm receipt in your Wise.",
              ],
              cta: input.actionUrl ? { label: "Confirm payment", url: input.actionUrl } : undefined,
            },
          };
    }
    case "lesson_insights_review_teacher": {
      const v = input.variables as TemplateVariables["lesson_insights_review_teacher"];
      return es
        ? {
            subject: `Áreas de enfoque listas — ${v.studentName}`,
            textBody: `Hola ${v.teacherName}, tu asistente preparó áreas de enfoque de tu clase con ${v.studentName}. Revísalas y confirma las que valga la pena guardar (forman el perfil del alumno).\n\nRevisar: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `${v.studentName} · áreas de enfoque por revisar`,
              heading: "Áreas de enfoque listas para revisar",
              paragraphs: [
                `Hola ${v.teacherName}, tu asistente preparó áreas de enfoque de tu clase con ${v.studentName}.`,
                "Revísalas en unos segundos y confirma las que valga la pena guardar; las confirmadas forman el perfil de aprendizaje del alumno.",
              ],
              cta: input.actionUrl
                ? { label: "Revisar áreas de enfoque", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `Focus areas ready — ${v.studentName}`,
            textBody: `Hi ${v.teacherName}, your assistant drafted focus areas from your class with ${v.studentName}. Review them and confirm the ones worth keeping (they build the student's profile).\n\nReview: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `${v.studentName} · focus areas to review`,
              heading: "Focus areas ready to review",
              paragraphs: [
                `Hi ${v.teacherName}, your assistant drafted focus areas from your class with ${v.studentName}.`,
                "Review them in a few seconds and confirm the ones worth keeping; confirmed ones build the student's learning profile.",
              ],
              cta: input.actionUrl
                ? { label: "Review focus areas", url: input.actionUrl }
                : undefined,
            },
          };
    }
    case "student_acquisition_plan_teacher": {
      const v = input.variables as TemplateVariables["student_acquisition_plan_teacher"];
      const esFirst = v.firstAction || "tu primera acción de la semana";
      const enFirst = v.firstAction || "your first action of the week";
      return es
        ? {
            subject: `Tu plan de esta semana: ${v.actionCount} acción${v.actionCount === 1 ? "" : "es"}`,
            textBody: `Hola ${v.teacherName}, ya te preparamos el plan de esta semana: ${v.actionCount} acción${v.actionCount === 1 ? "" : "es"}, unos ${v.minutes} minutos en total.\n\nEmpieza por aquí: ${esFirst}\n\n${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: "El texto, la imagen y el enlace ya están listos",
              heading: "Tu plan de esta semana",
              paragraphs: [
                `Hola ${v.teacherName}, te preparamos ${v.actionCount} acción${v.actionCount === 1 ? "" : "es"} para conseguir alumnos. Son unos ${v.minutes} minutos en total.`,
                `Empieza por aquí: ${esFirst}. El texto, la imagen y el enlace ya están listos — solo revisas y publicas.`,
              ],
              cta: input.actionUrl ? { label: "Ver mi plan", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Your plan this week: ${v.actionCount} action${v.actionCount === 1 ? "" : "s"}`,
            textBody: `Hi ${v.teacherName}, this week's plan is ready: ${v.actionCount} action${v.actionCount === 1 ? "" : "s"}, about ${v.minutes} minutes in total.\n\nStart here: ${enFirst}\n\n${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: "The text, the image and the link are already prepared",
              heading: "Your plan this week",
              paragraphs: [
                `Hi ${v.teacherName}, we've prepared ${v.actionCount} action${v.actionCount === 1 ? "" : "s"} to get you students — about ${v.minutes} minutes in total.`,
                `Start here: ${enFirst}. The text, the image and the link are already prepared — you just review and post.`,
              ],
              cta: input.actionUrl ? { label: "See my plan", url: input.actionUrl } : undefined,
            },
          };
    }
    case "facebook_groups_nudge_teacher": {
      const v = input.variables as TemplateVariables["facebook_groups_nudge_teacher"];
      const esGroups =
        v.groupCount > 0
          ? `tus ${v.groupCount} grupo${v.groupCount === 1 ? "" : "s"}`
          : "tus grupos";
      const enGroups =
        v.groupCount > 0
          ? `your ${v.groupCount} group${v.groupCount === 1 ? "" : "s"}`
          : "your groups";
      return es
        ? {
            subject: "¿Listo para volver a publicar en tus grupos?",
            textBody: `Hola ${v.teacherName}, pasaron un par de semanas desde tu último recordatorio. Volver a publicar tu enlace en ${esGroups} de Facebook es de lo que mejor llena tu agenda.\n\nAbre tu lista de grupos y comparte: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: "Volver a publicar en tus grupos llena tu agenda",
              heading: "Hora de volver a compartir",
              paragraphs: [
                `Hola ${v.teacherName}, pasaron un par de semanas desde tu último recordatorio.`,
                `Volver a publicar tu enlace en ${esGroups} de Facebook es de lo que mejor llena tu agenda — publica con el tono de cada grupo, como siempre.`,
              ],
              cta: input.actionUrl ? { label: "Ver mis grupos", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: "Time to post in your groups again?",
            textBody: `Hi ${v.teacherName}, it's been a couple of weeks since your last reminder. Posting your link in ${enGroups} on Facebook is one of the best ways to fill your schedule.\n\nOpen your group list and share: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: "Posting in your groups again fills your schedule",
              heading: "Time to share again",
              paragraphs: [
                `Hi ${v.teacherName}, it's been a couple of weeks since your last reminder.`,
                `Posting your link in ${enGroups} on Facebook is one of the best ways to fill your schedule — post in each group's voice, like always.`,
              ],
              cta: input.actionUrl ? { label: "View my groups", url: input.actionUrl } : undefined,
            },
          };
    }
    case "payment_failed_student": {
      const v = input.variables as TemplateVariables["payment_failed_student"];
      return es
        ? {
            subject: `Tu pago no se completó — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Tu pago por ${v.packageName} no se pudo procesar, así que el paquete no quedó activo.\n\nVuelve a intentarlo aquí — puedes pagar con tarjeta o por transferencia (Wise): ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Tu pago no se completó`,
              heading: "Pago no completado",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Tu pago por ${v.packageName} no se pudo procesar, así que el paquete no quedó activo.`,
                "Puedes volver a intentarlo cuando quieras — con tarjeta o por transferencia (Wise), lo que te sea más fácil.",
              ],
              cta: input.actionUrl
                ? { label: "Volver a intentar", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `Your payment didn't go through — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. Your payment for ${v.packageName} couldn't be processed, so the package wasn't activated.\n\nTry again here — you can pay by card or bank transfer (Wise): ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Payment didn't complete`,
              heading: "Payment didn't complete",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Your payment for ${v.packageName} couldn't be processed, so the package wasn't activated.`,
                "You can try again whenever you're ready — by card or bank transfer (Wise), whichever is easier.",
              ],
              cta: input.actionUrl ? { label: "Try again", url: input.actionUrl } : undefined,
            },
          };
    }
    case "refund_issued_student": {
      const v = input.variables as TemplateVariables["refund_issued_student"];
      return es
        ? {
            subject: `Reembolso emitido — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Se procesó el reembolso de ${v.amount} por ${v.packageName}. El dinero regresa al mismo método de pago, normalmente en 5 a 10 días hábiles según tu banco.`,
            html: {
              preheader: `Reembolso de ${v.amount}`,
              heading: "Reembolso emitido",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Se procesó el reembolso de ${v.amount} por ${v.packageName}.`,
                "El dinero regresa al mismo método de pago, normalmente en 5 a 10 días hábiles según tu banco.",
              ],
            },
          }
        : {
            subject: `Refund issued — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. Your refund of ${v.amount} for ${v.packageName} was processed. The money goes back to the same payment method, usually within 5 to 10 business days depending on your bank.`,
            html: {
              preheader: `Refund of ${v.amount}`,
              heading: "Refund issued",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Your refund of ${v.amount} for ${v.packageName} was processed.`,
                "The money goes back to the same payment method, usually within 5 to 10 business days depending on your bank.",
              ],
            },
          };
    }
    case "refund_issued_teacher": {
      const v = input.variables as TemplateVariables["refund_issued_teacher"];
      return es
        ? {
            subject: `Reembolso emitido — ${v.studentName}`,
            textBody: `Hola ${v.teacherName}, se procesó un reembolso de ${v.amount} a ${v.studentName} por ${v.packageName}.\n\nDetalle del pago: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount}`,
              heading: "Reembolso emitido",
              paragraphs: [
                `Hola ${v.teacherName}, se procesó un reembolso de ${v.amount} a ${v.studentName} por ${v.packageName}.`,
                "El paquete quedó marcado como reembolsado en tu panel.",
              ],
              cta: input.actionUrl ? { label: "Ver pago", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Refund issued — ${v.studentName}`,
            textBody: `Hi ${v.teacherName}, a refund of ${v.amount} was processed for ${v.studentName}'s ${v.packageName}.\n\nPayment details: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount}`,
              heading: "Refund issued",
              paragraphs: [
                `Hi ${v.teacherName}, a refund of ${v.amount} was processed for ${v.studentName}'s ${v.packageName}.`,
                "The package is now marked refunded in your dashboard.",
              ],
              cta: input.actionUrl ? { label: "View payment", url: input.actionUrl } : undefined,
            },
          };
    }
    // Lost chargeback. Deliberately NOT worded as a refund: the money did not
    // go back voluntarily, and the student's classes are gone rather than
    // returned. Neither version accuses anybody of anything — a chargeback is
    // raised with a card issuer, its outcome is the issuer's, and a genuine
    // billing mix-up looks identical from here.
    case "dispute_lost_student": {
      const v = input.variables as TemplateVariables["dispute_lost_student"];
      return es
        ? {
            subject: `Se revirtió tu pago — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Tu banco revirtió el pago de ${v.amount} por ${v.packageName}, así que las clases que quedaban de ese paquete ya no están disponibles. Si crees que se trata de un error, escríbeme y lo resolvemos.`,
            html: {
              preheader: `Pago revertido · ${v.amount}`,
              heading: "Se revirtió tu pago",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Tu banco revirtió el pago de ${v.amount} por ${v.packageName}.`,
                "Las clases que quedaban de ese paquete ya no están disponibles. Si crees que se trata de un error, escríbeme y lo resolvemos.",
              ],
            },
          }
        : {
            subject: `Your payment was reversed — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. Your card issuer reversed the ${v.amount} payment for ${v.packageName}, so the remaining classes on that package are no longer available. If you think this is a mistake, message me and we'll sort it out.`,
            html: {
              preheader: `Payment reversed · ${v.amount}`,
              heading: "Your payment was reversed",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Your card issuer reversed the ${v.amount} payment for ${v.packageName}.`,
                "The remaining classes on that package are no longer available. If you think this is a mistake, message me and we'll sort it out.",
              ],
            },
          };
    }
    case "dispute_lost_teacher": {
      const v = input.variables as TemplateVariables["dispute_lost_teacher"];
      return es
        ? {
            subject: `Contracargo perdido — ${v.studentName}`,
            textBody: `Hola ${v.teacherName}, se resolvió en tu contra un contracargo de ${v.amount} por ${v.packageName} de ${v.studentName}. Stripe descontó ese monto y su comisión por contracargo de tu saldo, y las clases que le quedaban a ${v.studentName} de ese paquete se retiraron.\n\nDetalle del pago: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount}`,
              heading: "Contracargo perdido",
              paragraphs: [
                `Hola ${v.teacherName}, se resolvió en tu contra un contracargo de ${v.amount} por ${v.packageName} de ${v.studentName}.`,
                `Stripe descontó ese monto y su comisión por contracargo de tu saldo, y las clases que le quedaban a ${v.studentName} de ese paquete se retiraron.`,
              ],
              cta: input.actionUrl ? { label: "Ver pago", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Chargeback lost — ${v.studentName}`,
            textBody: `Hi ${v.teacherName}, a ${v.amount} chargeback on ${v.studentName}'s ${v.packageName} was decided against you. Stripe took that amount and its dispute fee out of your balance, and ${v.studentName}'s remaining classes on that package have been removed.\n\nPayment details: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `${v.studentName} · ${v.amount}`,
              heading: "Chargeback lost",
              paragraphs: [
                `Hi ${v.teacherName}, a ${v.amount} chargeback on ${v.studentName}'s ${v.packageName} was decided against you.`,
                `Stripe took that amount and its dispute fee out of your balance, and ${v.studentName}'s remaining classes on that package have been removed.`,
              ],
              cta: input.actionUrl ? { label: "View payment", url: input.actionUrl } : undefined,
            },
          };
    }
    case "stripe_ready_teacher": {
      const v = input.variables as TemplateVariables["stripe_ready_teacher"];
      return es
        ? {
            subject: `Tu Stripe ya está listo`,
            textBody: `Hola ${v.teacherName}, Stripe terminó de verificar tu cuenta y ya puedes cobrar pagos con tarjeta.\n\nComparte tu enlace de reservas: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Stripe ya acepta pagos en tu cuenta`,
              heading: "Stripe ya está listo",
              paragraphs: [
                `Hola ${v.teacherName}, Stripe terminó de verificar tu cuenta y ya puedes cobrar pagos con tarjeta.`,
                "Tu enlace de reservas ya puede aceptar pagos.",
              ],
              cta: input.actionUrl ? { label: "Abrir mi enlace", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Your Stripe is ready`,
            textBody: `Hi ${v.teacherName}, Stripe finished verifying your account — you can now accept card payments.\n\nShare your booking link: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Stripe is now accepting payments`,
              heading: "Your Stripe is ready",
              paragraphs: [
                `Hi ${v.teacherName}, Stripe finished verifying your account — you can now accept card payments.`,
                "Your booking link is ready to take card payments.",
              ],
              cta: input.actionUrl ? { label: "Open my link", url: input.actionUrl } : undefined,
            },
          };
    }
    case "stripe_requirements_teacher": {
      const v = input.variables as TemplateVariables["stripe_requirements_teacher"];
      return es
        ? {
            subject: `Stripe necesita información adicional`,
            textBody: `Hola ${v.teacherName}, Stripe pausó los cobros con tarjeta en tu cuenta porque hace falta información adicional. Mientras tanto, los nuevos pagos con tarjeta no podrán completarse.\n\nRevisa los requisitos: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Stripe pausó tus cobros`,
              heading: "Stripe necesita información",
              paragraphs: [
                `Hola ${v.teacherName}, Stripe pausó los cobros con tarjeta en tu cuenta porque hace falta información adicional.`,
                "Mientras tanto, los nuevos pagos con tarjeta no podrán completarse.",
              ],
              cta: input.actionUrl
                ? { label: "Revisar requisitos", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `Stripe needs more information`,
            textBody: `Hi ${v.teacherName}, Stripe paused card payments on your account because more information is needed. New card payments won't complete until you fix this.\n\nReview the requirements: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Stripe paused your card payments`,
              heading: "Stripe needs more info",
              paragraphs: [
                `Hi ${v.teacherName}, Stripe paused card payments on your account because more information is needed.`,
                "New card payments won't complete until you fix this.",
              ],
              cta: input.actionUrl
                ? { label: "Review requirements", url: input.actionUrl }
                : undefined,
            },
          };
    }
    case "account_disabled_teacher": {
      const v = input.variables as TemplateVariables["account_disabled_teacher"];
      return es
        ? {
            subject: `Tu cuenta de SpiralClass fue deshabilitada`,
            textBody: `Hola ${v.teacherName}, deshabilitamos tu cuenta de SpiralClass.\n\nMotivo: ${v.reason}\n\nSi crees que es un error, responde a este correo y revisamos tu caso.`,
            html: {
              preheader: `Tu cuenta fue deshabilitada`,
              heading: "Tu cuenta fue deshabilitada",
              paragraphs: [
                `Hola ${v.teacherName}, deshabilitamos tu cuenta de SpiralClass.`,
                `Motivo: ${v.reason}`,
                "Si crees que es un error, responde a este correo y revisamos tu caso.",
              ],
            },
          }
        : {
            subject: `Your SpiralClass account was disabled`,
            textBody: `Hi ${v.teacherName}, your SpiralClass account has been disabled.\n\nReason: ${v.reason}\n\nIf you believe this is a mistake, reply to this email and we'll review.`,
            html: {
              preheader: `Account disabled`,
              heading: "Your account was disabled",
              paragraphs: [
                `Hi ${v.teacherName}, your SpiralClass account has been disabled.`,
                `Reason: ${v.reason}`,
                "If you believe this is a mistake, reply to this email and we'll review.",
              ],
            },
          };
    }
    case "booking_created_teacher": {
      const v = input.variables as TemplateVariables["booking_created_teacher"];
      return es
        ? {
            subject: `Nueva clase reservada — ${v.studentName}`,
            textBody: `Hola ${v.teacherName}, ${v.studentName} reservó una clase para el ${v.classDateTime}.\n\nVer agenda: ${input.actionUrl ?? "(enlace pendiente)"}${calLine}`,
            html: {
              preheader: `${v.studentName} · ${v.classDateTime}`,
              heading: "Nueva clase reservada",
              paragraphs: [
                `Hola ${v.teacherName}, ${v.studentName} reservó una clase para el ${v.classDateTime}.`,
              ],
              cta: input.actionUrl ? { label: "Ver agenda", url: input.actionUrl } : undefined,
              secondaryLink: calLink,
            },
          }
        : {
            subject: `New class booked — ${v.studentName}`,
            textBody: `Hi ${v.teacherName}, ${v.studentName} booked a class on ${v.classDateTime}.\n\nOpen dashboard: ${input.actionUrl ?? "(link pending)"}${calLine}`,
            html: {
              preheader: `${v.studentName} · ${v.classDateTime}`,
              heading: "New class booked",
              paragraphs: [
                `Hi ${v.teacherName}, ${v.studentName} booked a class on ${v.classDateTime}.`,
              ],
              cta: input.actionUrl ? { label: "Open dashboard", url: input.actionUrl } : undefined,
              secondaryLink: calLink,
            },
          };
    }
    case "homework_submitted_teacher": {
      const v = input.variables as TemplateVariables["homework_submitted_teacher"];
      const what = v.assignmentTitle
        ? es
          ? `entregó la tarea “${v.assignmentTitle}”`
          : `submitted the assignment “${v.assignmentTitle}”`
        : es
          ? "entregó una tarea"
          : "submitted homework";
      return es
        ? {
            subject: `Tarea entregada — ${v.studentName}`,
            textBody: `Hola ${v.teacherName}, ${v.studentName} ${what}.\n\nRevisar la clase: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `${v.studentName} · ${v.assignmentTitle || "Tarea"}`,
              heading: "Tarea entregada",
              paragraphs: [`Hola ${v.teacherName}, ${v.studentName} ${what}.`],
              cta: input.actionUrl
                ? { label: "Revisar la clase", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `Homework submitted — ${v.studentName}`,
            textBody: `Hi ${v.teacherName}, ${v.studentName} ${what}.\n\nReview the class: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `${v.studentName} · ${v.assignmentTitle || "Homework"}`,
              heading: "Homework submitted",
              paragraphs: [`Hi ${v.teacherName}, ${v.studentName} ${what}.`],
              cta: input.actionUrl
                ? { label: "Review the class", url: input.actionUrl }
                : undefined,
            },
          };
    }
    case "cancel_lt24h_teacher": {
      const v = input.variables as TemplateVariables["cancel_lt24h_teacher"];
      const policyUrl = cancellationPolicyUrl(input.appUrl, es);
      const archivedNote = v.studentArchived ? archivedSuppressionNote(v.studentName, es) : null;
      return es
        ? {
            subject: `${v.studentName} canceló con menos de 24h`,
            textBody:
              `Hola ${v.teacherName}, ${v.studentName} canceló la clase del ${v.originalDateTime} con menos de 24h. La clase se descontó del paquete según la política de cancelaciones.` +
              (archivedNote ? `\n\n${archivedNote}` : "") +
              `\n\nConsulta la política: ${policyUrl}`,
            html: {
              preheader: `${v.studentName} · ${v.originalDateTime}`,
              heading: "Cancelación tardía",
              paragraphs: [
                `Hola ${v.teacherName}, ${v.studentName} canceló la clase del ${v.originalDateTime} con menos de 24h.`,
                "La clase se descontó del paquete según la política de cancelaciones.",
                ...(archivedNote ? [archivedNote] : []),
              ],
              cta: { label: "Ver política de cancelaciones", url: policyUrl },
            },
          }
        : {
            subject: `${v.studentName} canceled late (<24h)`,
            textBody:
              `Hi ${v.teacherName}, ${v.studentName} canceled the ${v.originalDateTime} class with less than 24h notice. The class was deducted from their package per the cancellation policy.` +
              (archivedNote ? `\n\n${archivedNote}` : "") +
              `\n\nCancellation policy: ${policyUrl}`,
            html: {
              preheader: `${v.studentName} · ${v.originalDateTime}`,
              heading: "Late cancellation",
              paragraphs: [
                `Hi ${v.teacherName}, ${v.studentName} canceled the ${v.originalDateTime} class with less than 24h notice.`,
                "The class was deducted from their package per the cancellation policy.",
                ...(archivedNote ? [archivedNote] : []),
              ],
              cta: { label: "View cancellation policy", url: policyUrl },
            },
          };
    }
    case "cancel_gte24h_teacher": {
      const v = input.variables as TemplateVariables["cancel_gte24h_teacher"];
      const archivedNote = v.studentArchived ? archivedSuppressionNote(v.studentName, es) : null;
      return es
        ? {
            subject: `${v.studentName} canceló su clase`,
            textBody:
              `Hola ${v.teacherName}, ${v.studentName} canceló la clase del ${v.originalDateTime} con anticipación. La clase queda disponible para reagendar; no se descontó del paquete.` +
              (archivedNote ? `\n\n${archivedNote}` : ""),
            html: {
              preheader: `${v.studentName} · ${v.originalDateTime}`,
              heading: "Clase cancelada",
              paragraphs: [
                `Hola ${v.teacherName}, ${v.studentName} canceló la clase del ${v.originalDateTime} con anticipación.`,
                "La clase queda disponible para reagendar; no se descontó del paquete.",
                ...(archivedNote ? [archivedNote] : []),
              ],
            },
          }
        : {
            subject: `${v.studentName} canceled their class`,
            textBody:
              `Hi ${v.teacherName}, ${v.studentName} canceled the ${v.originalDateTime} class on time. The class remains available to reschedule; nothing was deducted.` +
              (archivedNote ? `\n\n${archivedNote}` : ""),
            html: {
              preheader: `${v.studentName} · ${v.originalDateTime}`,
              heading: "Class canceled",
              paragraphs: [
                `Hi ${v.teacherName}, ${v.studentName} canceled the ${v.originalDateTime} class on time.`,
                "The class remains available to reschedule; nothing was deducted.",
                ...(archivedNote ? [archivedNote] : []),
              ],
            },
          };
    }
    case "reschedule_confirm_teacher": {
      const v = input.variables as TemplateVariables["reschedule_confirm_teacher"];
      return es
        ? {
            subject: `${v.studentName} reagendó su clase`,
            textBody: `Hola ${v.teacherName}, ${v.studentName} cambió su clase del ${v.oldDateTime} al ${v.newDateTime}.`,
            html: {
              preheader: `${v.studentName} → ${v.newDateTime}`,
              heading: "Clase reagendada",
              paragraphs: [
                `Hola ${v.teacherName}, ${v.studentName} cambió su clase del ${v.oldDateTime} al ${v.newDateTime}.`,
              ],
            },
          }
        : {
            subject: `${v.studentName} rescheduled their class`,
            textBody: `Hi ${v.teacherName}, ${v.studentName} moved their class from ${v.oldDateTime} to ${v.newDateTime}.`,
            html: {
              preheader: `${v.studentName} → ${v.newDateTime}`,
              heading: "Class rescheduled",
              paragraphs: [
                `Hi ${v.teacherName}, ${v.studentName} moved their class from ${v.oldDateTime} to ${v.newDateTime}.`,
              ],
            },
          };
    }
    case "package_expiry_nudge": {
      const v = input.variables as TemplateVariables["package_expiry_nudge"];
      return es
        ? {
            subject: `Te quedan clases por usar con ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Tu paquete "${v.packageName}" vence el ${v.expiryDate} y aún tienes ${v.classesRemaining} clase(s) por usar. Reserva ahora para no perderlas.\n\nReservar: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Vence el ${v.expiryDate} · ${v.classesRemaining} clase(s) por usar`,
              heading: "No pierdas tus clases",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Tu paquete "${v.packageName}" vence el ${v.expiryDate} y aún tienes ${v.classesRemaining} clase(s) por usar.`,
                "Reserva ahora para aprovecharlas antes de que venzan.",
              ],
              cta: input.actionUrl
                ? { label: "Reservar mi clase", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `You still have classes to use with ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. Your "${v.packageName}" package expires on ${v.expiryDate} and you still have ${v.classesRemaining} class(es) left. Book now so you don't lose them.\n\nBook: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Expires ${v.expiryDate} · ${v.classesRemaining} class(es) left`,
              heading: "Don't lose your classes",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. Your "${v.packageName}" package expires on ${v.expiryDate} and you still have ${v.classesRemaining} class(es) left.`,
                "Book now to use them before they expire.",
              ],
              cta: input.actionUrl ? { label: "Book my class", url: input.actionUrl } : undefined,
            },
          };
    }
    case "package_consumed_student": {
      const v = input.variables as TemplateVariables["package_consumed_student"];
      return es
        ? {
            subject: `Ya usaste todas tus clases con ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Ya usaste todas las clases de tu paquete "${v.packageName}" — ¡gracias por aprender conmigo! Si quieres seguir, puedes comprar tu siguiente paquete desde tu portal, sin volver a llenar tus datos.\n\nComprar: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Tu paquete "${v.packageName}" se completó`,
              heading: "¿Seguimos con tus clases?",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Ya usaste todas las clases de tu paquete "${v.packageName}" — ¡gracias por aprender conmigo!`,
                "Si quieres seguir, puedes comprar tu siguiente paquete desde tu portal, sin volver a llenar tus datos.",
              ],
              cta: input.actionUrl
                ? { label: "Comprar otro paquete", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `You've used all your classes with ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. You've used all the classes in your "${v.packageName}" package — thanks for learning with me! Want to keep going? You can buy your next package from your portal, no need to re-enter your details.\n\nBuy: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Your "${v.packageName}" package is complete`,
              heading: "Shall we keep going?",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. You've used all the classes in your "${v.packageName}" package — thanks for learning with me!`,
                "Want to keep going? You can buy your next package from your portal, no need to re-enter your details.",
              ],
              cta: input.actionUrl
                ? { label: "Buy another package", url: input.actionUrl }
                : undefined,
            },
          };
    }
    case "package_consumed_teacher": {
      const v = input.variables as TemplateVariables["package_consumed_teacher"];
      // The student only gets their own renewal notice when their
      // `expiry_reminders` category is on (imported / opted-out students get
      // nothing). When it didn't go out, drop the "we already told them" line
      // so the email never claims a send that didn't happen — and lean on the
      // teacher's own WhatsApp follow-up, which is then the only channel.
      const secondLineEs = v.studentNotified
        ? "Le enviamos un aviso con el enlace para renovar desde su portal; un mensaje tuyo por WhatsApp suele ayudar a cerrar la renovación."
        : "No recibe avisos automáticos nuestros, así que un mensaje tuyo por WhatsApp es la mejor forma de proponerle renovar.";
      const secondLineEn = v.studentNotified
        ? "We sent them a renewal link to their portal; a personal WhatsApp message from you usually helps close the renewal."
        : "They don't get automatic notices from us, so a personal WhatsApp message from you is the best way to invite them to renew.";
      return es
        ? {
            subject: `${v.studentName} terminó su paquete`,
            textBody: `Hola ${v.teacherName}, ${v.studentName} ya usó todas las clases de su paquete "${v.packageName}". ${secondLineEs}`,
            html: {
              preheader: `${v.studentName} · "${v.packageName}" completado`,
              heading: "Oportunidad de renovación",
              paragraphs: [
                `Hola ${v.teacherName}, ${v.studentName} ya usó todas las clases de su paquete "${v.packageName}".`,
                secondLineEs,
              ],
              cta: input.actionUrl ? { label: "Ver alumno", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `${v.studentName} finished their package`,
            textBody: `Hi ${v.teacherName}, ${v.studentName} has used all the classes in their "${v.packageName}" package. ${secondLineEn}`,
            html: {
              preheader: `${v.studentName} · "${v.packageName}" complete`,
              heading: "Renewal opportunity",
              paragraphs: [
                `Hi ${v.teacherName}, ${v.studentName} has used all the classes in their "${v.packageName}" package.`,
                secondLineEn,
              ],
              cta: input.actionUrl ? { label: "View student", url: input.actionUrl } : undefined,
            },
          };
    }
    case "no_show_student": {
      const v = input.variables as TemplateVariables["no_show_student"];
      const policyUrl = cancellationPolicyUrl(input.appUrl, es);
      return es
        ? {
            subject: `Tu clase del ${v.originalDateTime} se marcó como no asistencia`,
            textBody: `Hola, soy ${v.teacherName}. Marqué la clase del ${v.originalDateTime} como no asistencia, así que se descontó del paquete según la política de cancelaciones.\n\nSi crees que fue un error, escríbeme por WhatsApp.\n\nConsulta la política: ${policyUrl}`,
            html: {
              preheader: `Clase marcada como no asistencia`,
              heading: "Clase no atendida",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Marqué la clase del ${v.originalDateTime} como no asistencia, así que se descontó del paquete según la política de cancelaciones.`,
                "Si crees que fue un error, escríbeme por WhatsApp.",
              ],
              cta: { label: "Ver política de cancelaciones", url: policyUrl },
            },
          }
        : {
            subject: `Class on ${v.originalDateTime} marked as no-show`,
            textBody: `Hi, I'm ${v.teacherName}. I marked the ${v.originalDateTime} class as a no-show, so it was deducted from your package per the cancellation policy.\n\nIf you think this is a mistake, message me on WhatsApp.\n\nCancellation policy: ${policyUrl}`,
            html: {
              preheader: `Class marked as no-show`,
              heading: "No-show recorded",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. I marked the ${v.originalDateTime} class as a no-show, so it was deducted from your package per the cancellation policy.`,
                "If you think this is a mistake, message me on WhatsApp.",
              ],
              cta: { label: "View cancellation policy", url: policyUrl },
            },
          };
    }
    case "subscription_trial_ending": {
      const v = input.variables as TemplateVariables["subscription_trial_ending"];
      return es
        ? {
            subject: `Tu prueba Pro termina en ${v.daysRemaining} días`,
            textBody: `Hola ${v.teacherName}, tu prueba gratuita de SpiralClass Pro termina en ${v.daysRemaining} días. Si no te suscribes, tu cuenta pasa al plan Gratis (sigues con tu página de reservas y ambos métodos de cobro; pierdes WhatsApp, alumnos ilimitados y materiales).\n\nElegir un plan: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Tu prueba Pro termina en ${v.daysRemaining} días`,
              heading: "Tu prueba Pro está por terminar",
              paragraphs: [
                `Hola ${v.teacherName}, tu prueba gratuita de SpiralClass Pro termina en ${v.daysRemaining} días.`,
                "Si no te suscribes, tu cuenta pasa al plan Gratis — sigues con tu página de reservas y ambos métodos de cobro, pero pierdes los recordatorios por WhatsApp, los alumnos ilimitados y los materiales.",
              ],
              cta: input.actionUrl ? { label: "Elegir un plan", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Your Pro trial ends in ${v.daysRemaining} days`,
            textBody: `Hi ${v.teacherName}, your free SpiralClass Pro trial ends in ${v.daysRemaining} days. If you don't subscribe, your account moves to the Free plan (you keep your booking page and both payment rails; you lose WhatsApp reminders, unlimited students, and materials).\n\nChoose a plan: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Your Pro trial ends in ${v.daysRemaining} days`,
              heading: "Your Pro trial is ending",
              paragraphs: [
                `Hi ${v.teacherName}, your free SpiralClass Pro trial ends in ${v.daysRemaining} days.`,
                "If you don't subscribe, your account moves to the Free plan — you keep your booking page and both payment rails, but you lose WhatsApp reminders, unlimited students, and materials.",
              ],
              cta: input.actionUrl ? { label: "Choose a plan", url: input.actionUrl } : undefined,
            },
          };
    }
    case "subscription_payment_succeeded": {
      const v = input.variables as TemplateVariables["subscription_payment_succeeded"];
      return es
        ? {
            subject: `Recibo SpiralClass Pro — ${v.amount}`,
            textBody: `Hola ${v.teacherName}, recibimos tu pago de ${v.amount} por SpiralClass Pro. Tu próxima fecha de cobro es el ${v.nextChargeDate}.\n\nVer mi facturación: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Pago recibido · ${v.amount}`,
              heading: "Pago recibido",
              paragraphs: [
                `Hola ${v.teacherName}, recibimos tu pago de ${v.amount} por SpiralClass Pro.`,
                `Tu próxima fecha de cobro es el ${v.nextChargeDate}.`,
              ],
              cta: input.actionUrl
                ? { label: "Ver mi facturación", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `SpiralClass Pro receipt — ${v.amount}`,
            textBody: `Hi ${v.teacherName}, we received your ${v.amount} payment for SpiralClass Pro. Your next charge date is ${v.nextChargeDate}.\n\nView billing: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Payment received · ${v.amount}`,
              heading: "Payment received",
              paragraphs: [
                `Hi ${v.teacherName}, we received your ${v.amount} payment for SpiralClass Pro.`,
                `Your next charge date is ${v.nextChargeDate}.`,
              ],
              cta: input.actionUrl ? { label: "View billing", url: input.actionUrl } : undefined,
            },
          };
    }
    case "subscription_payment_failed": {
      const v = input.variables as TemplateVariables["subscription_payment_failed"];
      return es
        ? {
            subject: `No pudimos procesar tu pago Pro`,
            textBody: `Hola ${v.teacherName}, no pudimos procesar el cobro de tu suscripción SpiralClass Pro. Mantienes todas las funciones Pro durante ${v.graceDays} días mientras actualizas tu método de pago; después tu cuenta pasa al plan Gratis.\n\nActualizar mi pago: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Actualiza tu método de pago`,
              heading: "No pudimos procesar tu pago",
              paragraphs: [
                `Hola ${v.teacherName}, no pudimos procesar el cobro de tu suscripción SpiralClass Pro.`,
                `Mantienes todas las funciones Pro durante ${v.graceDays} días mientras actualizas tu método de pago; después tu cuenta pasa al plan Gratis.`,
              ],
              cta: input.actionUrl
                ? { label: "Actualizar mi pago", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `We couldn't process your Pro payment`,
            textBody: `Hi ${v.teacherName}, we couldn't process your SpiralClass Pro subscription charge. You keep all Pro features for ${v.graceDays} days while you update your payment method; after that your account moves to the Free plan.\n\nUpdate payment: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Update your payment method`,
              heading: "We couldn't process your payment",
              paragraphs: [
                `Hi ${v.teacherName}, we couldn't process your SpiralClass Pro subscription charge.`,
                `You keep all Pro features for ${v.graceDays} days while you update your payment method; after that your account moves to the Free plan.`,
              ],
              cta: input.actionUrl ? { label: "Update payment", url: input.actionUrl } : undefined,
            },
          };
    }
    case "subscription_canceled": {
      const v = input.variables as TemplateVariables["subscription_canceled"];
      return es
        ? {
            subject: `Tu suscripción Pro terminó`,
            textBody: `Hola ${v.teacherName}, tu suscripción SpiralClass Pro terminó y tu cuenta está ahora en el plan Gratis. No te preocupes: tus alumnos, paquetes y tu página de reservas siguen funcionando. Solo se pausan WhatsApp, los alumnos ilimitados y los materiales hasta que vuelvas a Pro.\n\nVolver a Pro: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Ahora estás en el plan Gratis`,
              heading: "Tu suscripción Pro terminó",
              paragraphs: [
                `Hola ${v.teacherName}, tu suscripción SpiralClass Pro terminó y tu cuenta está ahora en el plan Gratis.`,
                "Tus alumnos, paquetes y tu página de reservas siguen funcionando. Solo se pausan WhatsApp, los alumnos ilimitados y los materiales hasta que vuelvas a Pro.",
              ],
              cta: input.actionUrl ? { label: "Volver a Pro", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Your Pro subscription ended`,
            textBody: `Hi ${v.teacherName}, your SpiralClass Pro subscription ended and your account is now on the Free plan. Don't worry: your students, packages, and booking page keep working. Only WhatsApp, unlimited students, and materials pause until you go Pro again.\n\nGo Pro again: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `You're now on the Free plan`,
              heading: "Your Pro subscription ended",
              paragraphs: [
                `Hi ${v.teacherName}, your SpiralClass Pro subscription ended and your account is now on the Free plan.`,
                "Your students, packages, and booking page keep working. Only WhatsApp, unlimited students, and materials pause until you go Pro again.",
              ],
              cta: input.actionUrl ? { label: "Go Pro again", url: input.actionUrl } : undefined,
            },
          };
    }
    case "subscription_founding_price_locked": {
      const v = input.variables as TemplateVariables["subscription_founding_price_locked"];
      return es
        ? {
            subject: `Bienvenida al precio fundador — ${v.amount}/mes para siempre`,
            textBody: `Hola ${v.teacherName}, ¡quedaste en el grupo fundador! Tu precio de ${v.amount}/mes queda bloqueado de por vida — nunca sube, aunque cambien los precios de Pro.\n\nVer mi facturación: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Precio fundador bloqueado · ${v.amount}/mes`,
              heading: "Precio fundador bloqueado",
              paragraphs: [
                `Hola ${v.teacherName}, ¡quedaste en el grupo fundador!`,
                `Tu precio de ${v.amount}/mes queda bloqueado de por vida — nunca sube, aunque cambien los precios de Pro.`,
              ],
              cta: input.actionUrl
                ? { label: "Ver mi facturación", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `Welcome to founding pricing — ${v.amount}/mo for life`,
            textBody: `Hi ${v.teacherName}, you're in the founding group! Your ${v.amount}/mo price is locked for the life of your subscription — it never increases, even when Pro prices change.\n\nView billing: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `Founding price locked · ${v.amount}/mo`,
              heading: "Founding price locked",
              paragraphs: [
                `Hi ${v.teacherName}, you're in the founding group!`,
                `Your ${v.amount}/mo price is locked for the life of your subscription — it never increases, even when Pro prices change.`,
              ],
              cta: input.actionUrl ? { label: "View billing", url: input.actionUrl } : undefined,
            },
          };
    }
    case "library_material_assigned": {
      const v = input.variables as TemplateVariables["library_material_assigned"];
      return es
        ? {
            subject: `Nuevo material — ${v.teacherName}`,
            textBody: `Hola, soy ${v.teacherName}. Te asigné un material nuevo: "${v.materialLabel}". Lo encuentras en la sección de materiales de tu portal.\n\nVer materiales: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: `Nuevo material: ${v.materialLabel}`,
              heading: "Nuevo material para ti",
              paragraphs: [
                `Hola, soy ${v.teacherName}. Te asigné un material nuevo: "${v.materialLabel}".`,
                "Lo encuentras en la sección de materiales de tu portal.",
              ],
              cta: input.actionUrl ? { label: "Ver materiales", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `New material — ${v.teacherName}`,
            textBody: `Hi, I'm ${v.teacherName}. I assigned you a new material: "${v.materialLabel}". You'll find it in the materials section of your portal.\n\nView materials: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: `New material: ${v.materialLabel}`,
              heading: "A new material for you",
              paragraphs: [
                `Hi, I'm ${v.teacherName}. I assigned you a new material: "${v.materialLabel}".`,
                "You'll find it in the materials section of your portal.",
              ],
              cta: input.actionUrl ? { label: "View materials", url: input.actionUrl } : undefined,
            },
          };
    }
    case "chat_message": {
      const v = input.variables as TemplateVariables["chat_message"];
      return es
        ? {
            subject: `Mensaje de ${v.teacherName}`,
            textBody: `${v.teacherName} te envió un mensaje: "${v.preview}".\n\nVer conversación: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: v.preview,
              heading: `Mensaje de ${v.teacherName}`,
              paragraphs: [`"${v.preview}"`],
              cta: input.actionUrl
                ? { label: "Ver conversación", url: input.actionUrl }
                : undefined,
            },
          }
        : {
            subject: `Message from ${v.teacherName}`,
            textBody: `${v.teacherName} sent you a message: "${v.preview}".\n\nView conversation: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: v.preview,
              heading: `Message from ${v.teacherName}`,
              paragraphs: [`"${v.preview}"`],
              cta: input.actionUrl
                ? { label: "View conversation", url: input.actionUrl }
                : undefined,
            },
          };
    }
    case "homework_assigned_student": {
      const v = input.variables as TemplateVariables["homework_assigned_student"];
      const what = v.assignmentTitle ? `“${v.assignmentTitle}”` : es ? "una tarea" : "homework";
      return es
        ? {
            subject: `Nueva tarea de ${v.teacherName}`,
            textBody: `${v.teacherName} te asignó ${what}.\n\nVer la clase: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: v.assignmentTitle || "Nueva tarea",
              heading: "Nueva tarea",
              paragraphs: [`${v.teacherName} te asignó ${what}.`],
              cta: input.actionUrl ? { label: "Ver la clase", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `New homework from ${v.teacherName}`,
            textBody: `${v.teacherName} assigned you ${what}.\n\nView the class: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: v.assignmentTitle || "New homework",
              heading: "New homework",
              paragraphs: [`${v.teacherName} assigned you ${what}.`],
              cta: input.actionUrl ? { label: "View the class", url: input.actionUrl } : undefined,
            },
          };
    }
    case "homework_feedback_available_student": {
      const v = input.variables as TemplateVariables["homework_feedback_available_student"];
      const title = v.assignmentTitle
        ? `"${v.assignmentTitle}"`
        : es
          ? "tu tarea"
          : "your homework";
      if (v.decision === "approved") {
        return es
          ? {
              subject: `${v.teacherName} aprobó tu tarea`,
              textBody: `${v.teacherName} aprobó ${title}. Mira su retroalimentación.\n\nVer la clase: ${input.actionUrl ?? "(enlace pendiente)"}`,
              html: {
                preheader: "Tarea aprobada",
                heading: "Tarea aprobada",
                paragraphs: [`${v.teacherName} aprobó ${title}. Mira su retroalimentación.`],
                cta: input.actionUrl ? { label: "Ver la clase", url: input.actionUrl } : undefined,
              },
            }
          : {
              subject: `${v.teacherName} approved your homework`,
              textBody: `${v.teacherName} approved ${title}. See the feedback.\n\nView the class: ${input.actionUrl ?? "(link pending)"}`,
              html: {
                preheader: "Homework approved",
                heading: "Homework approved",
                paragraphs: [`${v.teacherName} approved ${title}. See the feedback.`],
                cta: input.actionUrl
                  ? { label: "View the class", url: input.actionUrl }
                  : undefined,
              },
            };
      }
      if (v.decision === "resubmission_requested") {
        return es
          ? {
              subject: `${v.teacherName} te pidió reenviar tu tarea`,
              textBody: `${v.teacherName} te pidió reenviar ${title}.\n\nVer la clase: ${input.actionUrl ?? "(enlace pendiente)"}`,
              html: {
                preheader: "Reenvía tu tarea",
                heading: "Reenvía tu tarea",
                paragraphs: [`${v.teacherName} te pidió reenviar ${title}.`],
                cta: input.actionUrl ? { label: "Ver la clase", url: input.actionUrl } : undefined,
              },
            }
          : {
              subject: `${v.teacherName} asked you to resubmit`,
              textBody: `${v.teacherName} asked you to resubmit ${title}.\n\nView the class: ${input.actionUrl ?? "(link pending)"}`,
              html: {
                preheader: "Resubmit your homework",
                heading: "Resubmit your homework",
                paragraphs: [`${v.teacherName} asked you to resubmit ${title}.`],
                cta: input.actionUrl
                  ? { label: "View the class", url: input.actionUrl }
                  : undefined,
              },
            };
      }
      return es
        ? {
            subject: `Retroalimentación de ${v.teacherName}`,
            textBody: `${v.teacherName} dejó retroalimentación en ${title}.\n\nVer la clase: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: "Retroalimentación de tu tarea",
              heading: "Retroalimentación de tu tarea",
              paragraphs: [`${v.teacherName} dejó retroalimentación en ${title}.`],
              cta: input.actionUrl ? { label: "Ver la clase", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Feedback from ${v.teacherName}`,
            textBody: `${v.teacherName} left feedback on ${title}.\n\nView the class: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: "Feedback on your homework",
              heading: "Feedback on your homework",
              paragraphs: [`${v.teacherName} left feedback on ${title}.`],
              cta: input.actionUrl ? { label: "View the class", url: input.actionUrl } : undefined,
            },
          };
    }
    case "homework_due_soon_student": {
      const v = input.variables as TemplateVariables["homework_due_soon_student"];
      const what = v.assignmentTitle ? `"${v.assignmentTitle}"` : es ? "tu tarea" : "your homework";
      return es
        ? {
            subject: `Tarea próxima a vencer`,
            textBody: `${what} vence el ${v.dueDate}.\n\nVer la clase: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: "Tarea próxima a vencer",
              heading: "Tarea próxima a vencer",
              paragraphs: [`${what} vence el ${v.dueDate}.`],
              cta: input.actionUrl ? { label: "Ver la clase", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Homework due soon`,
            textBody: `${what} is due ${v.dueDate}.\n\nView the class: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: "Homework due soon",
              heading: "Homework due soon",
              paragraphs: [`${what} is due ${v.dueDate}.`],
              cta: input.actionUrl ? { label: "View the class", url: input.actionUrl } : undefined,
            },
          };
    }
    case "homework_overdue_student": {
      const v = input.variables as TemplateVariables["homework_overdue_student"];
      const what = v.assignmentTitle ? `"${v.assignmentTitle}"` : es ? "tu tarea" : "your homework";
      return es
        ? {
            subject: `Tarea vencida`,
            textBody: `${what} ya venció. Puedes enviarla cuando quieras.\n\nVer la clase: ${input.actionUrl ?? "(enlace pendiente)"}`,
            html: {
              preheader: "Tarea vencida",
              heading: "Tarea vencida",
              paragraphs: [`${what} ya venció. Puedes enviarla cuando quieras.`],
              cta: input.actionUrl ? { label: "Ver la clase", url: input.actionUrl } : undefined,
            },
          }
        : {
            subject: `Homework overdue`,
            textBody: `${what} is overdue. You can still submit it.\n\nView the class: ${input.actionUrl ?? "(link pending)"}`,
            html: {
              preheader: "Homework overdue",
              heading: "Homework overdue",
              paragraphs: [`${what} is overdue. You can still submit it.`],
              cta: input.actionUrl ? { label: "View the class", url: input.actionUrl } : undefined,
            },
          };
    }
    case "chat_message_teacher": {
      const v = input.variables as TemplateVariables["chat_message_teacher"];
      return {
        subject: `Mensaje de ${v.studentName}`,
        textBody: `${v.studentName} te envió un mensaje: "${v.preview}".\n\nVer conversación: ${input.actionUrl ?? "(enlace pendiente)"}`,
        html: {
          preheader: v.preview,
          heading: `Mensaje de ${v.studentName}`,
          paragraphs: [`"${v.preview}"`],
          cta: input.actionUrl ? { label: "Ver conversación", url: input.actionUrl } : undefined,
        },
      };
    }
  }
  const _exhaustive: never = input.templateName;
  throw new Error(`unhandled template ${_exhaustive}`);
}
