// Notification push RENDERERS — the copy a push notification carries.
//
// `renderPush(template, lang, vars) → { title, body, deepLink }` is the single
// place a push's words are decided, and it has three readers: the Web Push
// transport (lib/notifications/web-push.ts), the dispatcher, and the in-app
// inbox (lib/notifications/inbox.ts), which renders the same title/body so what
// a teacher sees in her inbox can never drift from what she was sent.
//
// ⚠️ **There is no transport in this file.** Web Push is the transport;
// `push` is one CHANNEL with one transport, and everything here decides only
// the words a push carries.

import type { LanguageCode, TemplateName, TemplateVariables } from "./templates";

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export type RenderedPush = {
  title: string;
  body: string;
  // Relative path the app should route to on tap (e.g. `r/p/<pkg>`).
  // null for templates that have no actionable destination.
  deepLink: string | null;
  // Counterpart display name for deep links that land on a dynamic-segment
  // screen the client can't otherwise label (e.g. a chat thread) —
  // carried in the push `data` payload so the client doesn't have to look it
  // up separately. Undefined for templates that don't need it.
  deepLinkName?: string;
};

export function renderPush<T extends TemplateName>(
  templateName: T,
  language: LanguageCode,
  vars: TemplateVariables[T],
): RenderedPush {
  const es = language === "es_MX";
  switch (templateName) {
    case "booking_confirmation": {
      const v = vars as TemplateVariables["booking_confirmation"];
      return {
        title: es ? "Clase confirmada" : "Class confirmed",
        // Warm, second-person — mirrors the confirmation email's tone. A "·"
        // separator (not a period) keeps the classes-left count without
        // producing a double period after times that end in "p.m.".
        body: es
          ? `Tu clase con ${v.teacherName} es el ${v.classDateTime} · Te quedan ${v.classesRemaining} clases`
          : `Your class with ${v.teacherName} is on ${v.classDateTime} · ${v.classesRemaining} classes left`,
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "reminder_24h":
    case "reminder_1h":
    case "reminder_15m": {
      const v = vars as TemplateVariables["reminder_24h"];
      const lead =
        templateName === "reminder_24h"
          ? es
            ? "Mañana"
            : "Tomorrow"
          : templateName === "reminder_1h"
            ? es
              ? "En 1 hora"
              : "In 1 hour"
            : es
              ? "En 15 minutos"
              : "In 15 minutes";
      return {
        title: es ? `Recordatorio: ${lead}` : `Reminder: ${lead}`,
        // No trailing period: classDateTime ends in the "p.m." abbreviation, so
        // an appended sentence period renders as a double period ("p.m..").
        body: es
          ? `Clase con ${v.teacherName} el ${v.classDateTime}`
          : `Class with ${v.teacherName} on ${v.classDateTime}`,
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "reminder_24h_teacher":
    case "reminder_1h_teacher":
    case "reminder_15m_teacher": {
      const v = vars as TemplateVariables["reminder_24h_teacher"];
      const lead =
        templateName === "reminder_24h_teacher"
          ? es
            ? "Mañana"
            : "Tomorrow"
          : templateName === "reminder_1h_teacher"
            ? es
              ? "En 1 hora"
              : "In 1 hour"
            : es
              ? "En 15 minutos"
              : "In 15 minutes";
      return {
        title: es ? `Recordatorio: ${lead}` : `Reminder: ${lead}`,
        // Teacher-voiced: names the student, not the teacher. No trailing period
        // — classDateTime ends in "p.m." (double-period otherwise).
        body: es
          ? `Clase con ${v.studentName} el ${v.classDateTime}`
          : `Class with ${v.studentName} on ${v.classDateTime}`,
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "cancel_lt24h": {
      const v = vars as TemplateVariables["cancel_lt24h"];
      return {
        title: es ? "Clase cancelada" : "Class canceled",
        body: es
          ? `Tu clase del ${v.originalDateTime} con ${v.teacherName} fue cancelada (menos de 24 h).`
          : `Your class on ${v.originalDateTime} with ${v.teacherName} was canceled (less than 24 h).`,
        // r/re/<id> → the student book surface (not the canceled booking's
        // reschedule screen) so the student can pick a new slot.
        deepLink: v.reschedulePathSuffix ?? null,
      };
    }
    case "cancel_gte24h_with_reschedule":
    case "teacher_cancel": {
      const v = vars as TemplateVariables["cancel_gte24h_with_reschedule"];
      return {
        title:
          templateName === "teacher_cancel"
            ? es
              ? "Tu profe canceló"
              : "Your teacher canceled"
            : es
              ? "Clase cancelada"
              : "Class canceled",
        body: es
          ? `Clase del ${v.originalDateTime} con ${v.teacherName}. Reagenda cuando quieras.`
          : `Class on ${v.originalDateTime} with ${v.teacherName}. Reschedule anytime.`,
        deepLink: v.reschedulePathSuffix,
      };
    }
    case "reschedule_confirm": {
      const v = vars as TemplateVariables["reschedule_confirm"];
      return {
        title: es ? "Clase reagendada" : "Class rescheduled",
        body: es
          ? `Antes: ${v.oldDateTime}. Ahora: ${v.newDateTime} con ${v.teacherName}.`
          : `Was ${v.oldDateTime}. Now ${v.newDateTime} with ${v.teacherName}.`,
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "payment_received": {
      const v = vars as TemplateVariables["payment_received"];
      return {
        title: es ? "Pago recibido" : "Payment received",
        body: es
          ? `${v.packageName} con ${v.teacherName} — ${v.amount}.`
          : `${v.packageName} with ${v.teacherName} — ${v.amount}.`,
        deepLink: v.portalPathSuffix,
      };
    }
    case "magic_link": {
      const v = vars as TemplateVariables["magic_link"];
      return {
        title: es ? "Tu enlace para entrar" : "Your sign-in link",
        body: es
          ? `Toca para entrar al portal de ${v.teacherName}. Vence en ${v.expiryMinutes} min.`
          : `Tap to open ${v.teacherName}'s portal. Expires in ${v.expiryMinutes} min.`,
        deepLink: v.magicLinkPathSuffix,
      };
    }
    case "materials_send": {
      const v = vars as TemplateVariables["materials_send"];
      return {
        title: es ? "Materiales de clase" : "Class materials",
        body: es
          ? `Materiales para tu clase del ${v.classDateTime} con ${v.teacherName}.`
          : `Materials for your class on ${v.classDateTime} with ${v.teacherName}.`,
        deepLink: v.materialsPathSuffix,
      };
    }
    case "payment_pending_teacher": {
      const v = vars as TemplateVariables["payment_pending_teacher"];
      return {
        title: es ? "Pago Wise iniciado" : "Wise payment started",
        body: es
          ? `${v.studentName} compra ${v.packageName} (${v.amount}). Ref: ${v.wiseReference}.`
          : `${v.studentName} is buying ${v.packageName} (${v.amount}). Ref: ${v.wiseReference}.`,
        deepLink: v.paymentPathSuffix,
      };
    }
    case "payment_marked_sent_teacher": {
      const v = vars as TemplateVariables["payment_marked_sent_teacher"];
      return {
        title: es ? "Pago Wise enviado" : "Wise payment sent",
        body: es
          ? `${v.studentName} ya envió ${v.amount} por ${v.packageName}. Revisa Wise.`
          : `${v.studentName} sent ${v.amount} for ${v.packageName}. Check Wise.`,
        deepLink: v.paymentPathSuffix,
      };
    }
    case "lesson_insights_review_teacher": {
      const v = vars as TemplateVariables["lesson_insights_review_teacher"];
      return {
        title: es ? "Áreas de enfoque listas" : "Focus areas ready",
        body: es
          ? `Revisa las áreas de enfoque de tu clase con ${v.studentName}.`
          : `Review the focus areas from your class with ${v.studentName}.`,
        deepLink: v.dashboardPathSuffix,
      };
    }
    case "wise_confirm_reminder_teacher": {
      const v = vars as TemplateVariables["wise_confirm_reminder_teacher"];
      return {
        title: es ? "Confirma el pago Wise" : "Confirm Wise payment",
        body: es
          ? `${v.studentName}: ${v.amount} sigue sin confirmar. Confírmalo para activar el paquete.`
          : `${v.studentName}: ${v.amount} is still unconfirmed. Confirm it to activate the package.`,
        deepLink: v.paymentPathSuffix,
      };
    }
    case "payment_failed_student": {
      const v = vars as TemplateVariables["payment_failed_student"];
      return {
        title: es ? "Pago no completado" : "Payment didn't complete",
        body: es
          ? `Tu pago por ${v.packageName} con ${v.teacherName} no se procesó.`
          : `Your payment for ${v.packageName} with ${v.teacherName} didn't go through.`,
        deepLink: v.retryPathSuffix,
      };
    }
    case "refund_issued_student": {
      const v = vars as TemplateVariables["refund_issued_student"];
      return {
        title: es ? "Reembolso emitido" : "Refund issued",
        body: es
          ? `${v.amount} por ${v.packageName} con ${v.teacherName}.`
          : `${v.amount} for ${v.packageName} with ${v.teacherName}.`,
        deepLink: v.portalPathSuffix ?? null,
      };
    }
    case "refund_issued_teacher": {
      const v = vars as TemplateVariables["refund_issued_teacher"];
      return {
        title: es ? "Reembolso emitido" : "Refund issued",
        body: es
          ? `${v.amount} a ${v.studentName} por ${v.packageName}.`
          : `${v.amount} to ${v.studentName} for ${v.packageName}.`,
        deepLink: v.paymentPathSuffix,
      };
    }
    case "dispute_lost_student": {
      const v = vars as TemplateVariables["dispute_lost_student"];
      return {
        title: es ? "Se revirtió tu pago" : "Your payment was reversed",
        body: es
          ? `${v.amount} por ${v.packageName}. Las clases restantes ya no están disponibles.`
          : `${v.amount} for ${v.packageName}. The remaining classes are no longer available.`,
        deepLink: v.portalPathSuffix ?? null,
      };
    }
    case "dispute_lost_teacher": {
      const v = vars as TemplateVariables["dispute_lost_teacher"];
      return {
        title: es ? "Contracargo perdido" : "Chargeback lost",
        body: es
          ? `${v.amount} de ${v.studentName} por ${v.packageName}.`
          : `${v.amount} from ${v.studentName} for ${v.packageName}.`,
        deepLink: v.paymentPathSuffix,
      };
    }
    case "stripe_ready_teacher": {
      const v = vars as TemplateVariables["stripe_ready_teacher"];
      return {
        title: es ? "Stripe está listo" : "Stripe is ready",
        body: es ? "Ya puedes cobrar pagos con tarjeta." : "You can now accept card payments.",
        deepLink: v.bookingLinkPathSuffix,
      };
    }
    case "stripe_requirements_teacher": {
      const v = vars as TemplateVariables["stripe_requirements_teacher"];
      return {
        title: es ? "Stripe necesita información" : "Stripe needs more info",
        body: es ? "Los cobros con tarjeta están pausados." : "Card payments are paused.",
        deepLink: v.stripeSettingsPathSuffix,
      };
    }
    case "account_disabled_teacher": {
      return {
        title: es ? "Cuenta deshabilitada" : "Account disabled",
        body: es
          ? "Tu cuenta de SpiralClass fue deshabilitada. Revisa tu correo."
          : "Your SpiralClass account was disabled. Check your email.",
        deepLink: null,
      };
    }
    case "booking_created_teacher": {
      const v = vars as TemplateVariables["booking_created_teacher"];
      return {
        title: es ? "Nueva clase reservada" : "New class booked",
        // No trailing period — see booking_confirmation: classDateTime ends in
        // "p.m.", so appending "." produces a double period.
        body: es
          ? `${v.studentName} reservó para el ${v.classDateTime}`
          : `${v.studentName} booked ${v.classDateTime}`,
        deepLink: v.dashboardPathSuffix,
      };
    }
    case "cancel_lt24h_teacher": {
      const v = vars as TemplateVariables["cancel_lt24h_teacher"];
      return {
        title: es ? "Cancelación tardía" : "Late cancellation",
        body: es
          ? `${v.studentName} canceló el ${v.originalDateTime} (<24h).`
          : `${v.studentName} canceled ${v.originalDateTime} (<24h).`,
        deepLink: v.dashboardPathSuffix ?? null,
      };
    }
    case "cancel_gte24h_teacher": {
      const v = vars as TemplateVariables["cancel_gte24h_teacher"];
      return {
        title: es ? "Clase cancelada" : "Class canceled",
        body: es
          ? `${v.studentName} canceló el ${v.originalDateTime}.`
          : `${v.studentName} canceled ${v.originalDateTime}.`,
        deepLink: v.dashboardPathSuffix ?? null,
      };
    }
    case "reschedule_confirm_teacher": {
      const v = vars as TemplateVariables["reschedule_confirm_teacher"];
      return {
        title: es ? "Clase reagendada" : "Class rescheduled",
        body: es
          ? `${v.studentName}: ${v.oldDateTime} → ${v.newDateTime}.`
          : `${v.studentName}: ${v.oldDateTime} → ${v.newDateTime}.`,
        deepLink: v.dashboardPathSuffix ?? null,
      };
    }
    case "payment_received_teacher": {
      const v = vars as TemplateVariables["payment_received_teacher"];
      return {
        title: es ? "Nueva venta" : "New sale",
        body: es
          ? `${v.studentName} compró ${v.packageName} (${v.amount}).`
          : `${v.studentName} bought ${v.packageName} (${v.amount}).`,
        deepLink: v.paymentPathSuffix,
      };
    }
    case "wise_marked_sent_student": {
      const v = vars as TemplateVariables["wise_marked_sent_student"];
      return {
        title: es ? "Aviso enviado a tu profe" : "Your teacher was notified",
        body: es
          ? `Le avisamos a ${v.teacherName} que enviaste tu transferencia (${v.wiseReference}). Tu paquete se activa cuando la confirme.`
          : `We told ${v.teacherName} you sent your transfer (${v.wiseReference}). Your package activates once they confirm it.`,
        deepLink: v.portalPathSuffix ?? null,
      };
    }
    case "no_show_student": {
      const v = vars as TemplateVariables["no_show_student"];
      return {
        title: es ? "Clase no atendida" : "No-show recorded",
        body: es
          ? `${v.teacherName} marcó la clase del ${v.originalDateTime} como no asistencia.`
          : `${v.teacherName} marked the ${v.originalDateTime} class as a no-show.`,
        deepLink: v.classPathSuffix ?? null,
      };
    }
    case "package_expiry_nudge": {
      const v = vars as TemplateVariables["package_expiry_nudge"];
      return {
        title: es ? "No pierdas tus clases" : "Don't lose your classes",
        body: es
          ? `Te quedan ${v.classesRemaining} clase(s) con ${v.teacherName}; vencen el ${v.expiryDate}.`
          : `You have ${v.classesRemaining} class(es) left with ${v.teacherName}; they expire ${v.expiryDate}.`,
        // In-app book tab, not the public booking page — these are classes
        // already paid for, not a new package to buy.
        deepLink: v.bookPathSuffix ?? v.bookingLinkPathSuffix ?? null,
      };
    }
    case "package_consumed_student": {
      const v = vars as TemplateVariables["package_consumed_student"];
      return {
        title: es ? "¿Seguimos con tus clases?" : "Shall we keep going?",
        body: es
          ? `Ya usaste todas las clases de "${v.packageName}" con ${v.teacherName}. Compra tu siguiente paquete desde tu portal.`
          : `You've used all the classes in "${v.packageName}" with ${v.teacherName}. Buy your next package from your portal.`,
        deepLink: v.renewPathSuffix,
      };
    }
    case "package_consumed_teacher": {
      const v = vars as TemplateVariables["package_consumed_teacher"];
      return {
        title: es ? "Oportunidad de renovación" : "Renewal opportunity",
        body: es
          ? `${v.studentName} terminó su paquete "${v.packageName}".`
          : `${v.studentName} finished their "${v.packageName}" package.`,
        deepLink: v.studentPathSuffix,
      };
    }
    case "subscription_trial_ending": {
      const v = vars as TemplateVariables["subscription_trial_ending"];
      return {
        title: es ? "Tu prueba Pro termina pronto" : "Your Pro trial ends soon",
        body: es
          ? `Te quedan ${v.daysRemaining} días de prueba. Elige un plan para no perder Pro.`
          : `${v.daysRemaining} days left in your trial. Pick a plan to keep Pro.`,
        deepLink: v.billingPathSuffix,
      };
    }
    case "subscription_payment_succeeded": {
      const v = vars as TemplateVariables["subscription_payment_succeeded"];
      return {
        title: es ? "Pago recibido" : "Payment received",
        body: es
          ? `${v.amount} por SpiralClass Pro. Próximo cobro: ${v.nextChargeDate}.`
          : `${v.amount} for SpiralClass Pro. Next charge: ${v.nextChargeDate}.`,
        deepLink: v.billingPathSuffix,
      };
    }
    case "subscription_payment_failed": {
      const v = vars as TemplateVariables["subscription_payment_failed"];
      return {
        title: es ? "Actualiza tu método de pago" : "Update your payment method",
        body: es
          ? `No pudimos cobrar tu suscripción. Tienes ${v.graceDays} días para actualizarla.`
          : `We couldn't charge your subscription. You have ${v.graceDays} days to fix it.`,
        deepLink: v.billingPathSuffix,
      };
    }
    case "subscription_canceled": {
      const v = vars as TemplateVariables["subscription_canceled"];
      return {
        title: es ? "Tu suscripción Pro terminó" : "Your Pro subscription ended",
        body: es
          ? "Estás en el plan Gratis. Tus alumnos y reservas siguen activos."
          : "You're on the Free plan. Your students and bookings stay active.",
        deepLink: v.billingPathSuffix,
      };
    }
    case "subscription_founding_price_locked": {
      const v = vars as TemplateVariables["subscription_founding_price_locked"];
      return {
        title: es ? "Precio fundador bloqueado" : "Founding price locked",
        body: es
          ? `Tu precio de ${v.amount}/mes queda bloqueado de por vida.`
          : `Your ${v.amount}/mo price is locked for life.`,
        deepLink: v.billingPathSuffix,
      };
    }
    case "library_material_assigned": {
      const v = vars as TemplateVariables["library_material_assigned"];
      return {
        title: es ? "Nuevo material" : "New material",
        body: es
          ? `${v.teacherName} te asignó "${v.materialLabel}". Ábrelo en tus materiales.`
          : `${v.teacherName} assigned you "${v.materialLabel}". Open it in your materials.`,
        deepLink: v.materialsPathSuffix,
      };
    }
    case "homework_assigned_student": {
      const v = vars as TemplateVariables["homework_assigned_student"];
      return {
        title: es ? "Nueva tarea" : "New homework",
        body: es
          ? `${v.teacherName} te asignó "${v.assignmentTitle}".`
          : `${v.teacherName} assigned you "${v.assignmentTitle}".`,
        deepLink: v.classPathSuffix,
      };
    }
    case "homework_feedback_available_student": {
      const v = vars as TemplateVariables["homework_feedback_available_student"];
      const title =
        v.decision === "approved"
          ? es
            ? "Tarea aprobada"
            : "Homework approved"
          : v.decision === "resubmission_requested"
            ? es
              ? "Reenvía tu tarea"
              : "Resubmit your homework"
            : es
              ? "Retroalimentación de tu tarea"
              : "Feedback on your homework";
      const body =
        v.decision === "approved"
          ? es
            ? `${v.teacherName} aprobó "${v.assignmentTitle}". Mira su retroalimentación.`
            : `${v.teacherName} approved "${v.assignmentTitle}". See the feedback.`
          : v.decision === "resubmission_requested"
            ? es
              ? `${v.teacherName} te pidió reenviar "${v.assignmentTitle}".`
              : `${v.teacherName} asked you to resubmit "${v.assignmentTitle}".`
            : es
              ? `${v.teacherName} dejó retroalimentación en "${v.assignmentTitle}".`
              : `${v.teacherName} left feedback on "${v.assignmentTitle}".`;
      return { title, body, deepLink: v.classPathSuffix };
    }
    case "homework_due_soon_student": {
      const v = vars as TemplateVariables["homework_due_soon_student"];
      return {
        title: es ? "Tarea próxima a vencer" : "Homework due soon",
        body: es
          ? `"${v.assignmentTitle}" vence el ${v.dueDate}.`
          : `"${v.assignmentTitle}" is due ${v.dueDate}.`,
        deepLink: v.classPathSuffix,
      };
    }
    case "homework_overdue_student": {
      const v = vars as TemplateVariables["homework_overdue_student"];
      return {
        title: es ? "Tarea vencida" : "Homework overdue",
        body: es
          ? `"${v.assignmentTitle}" ya venció. Puedes enviarla cuando quieras.`
          : `"${v.assignmentTitle}" is overdue. You can still submit it.`,
        deepLink: v.classPathSuffix,
      };
    }
    case "facebook_groups_nudge_teacher": {
      const v = vars as TemplateVariables["facebook_groups_nudge_teacher"];
      return {
        title: es ? "Hora de volver a compartir" : "Time to share again",
        body: es
          ? "Vuelve a publicar tu enlace en tus grupos de Facebook — así llenas tu agenda."
          : "Post your link in your Facebook groups again — that's how you fill your schedule.",
        deepLink: v.dashboardPathSuffix,
      };
    }
    case "student_acquisition_plan_teacher": {
      const v = vars as TemplateVariables["student_acquisition_plan_teacher"];
      return {
        title: es ? "Tu plan de la semana" : "Your plan for the week",
        body: v.firstAction
          ? v.firstAction
          : es
            ? "Ya tienes acciones listas para conseguir alumnos."
            : "You have prepared actions ready to get students.",
        deepLink: v.dashboardPathSuffix,
      };
    }
    case "chat_message": {
      const v = vars as TemplateVariables["chat_message"];
      return {
        title: es ? `Mensaje de ${v.teacherName}` : `Message from ${v.teacherName}`,
        body: v.preview,
        deepLink: v.chatPathSuffix,
        deepLinkName: v.teacherName,
      };
    }
    case "chat_message_teacher": {
      const v = vars as TemplateVariables["chat_message_teacher"];
      return {
        title: es ? `Mensaje de ${v.studentName}` : `Message from ${v.studentName}`,
        body: v.preview,
        deepLink: v.chatPathSuffix,
        deepLinkName: v.studentName,
      };
    }
    case "homework_submitted_teacher": {
      const v = vars as TemplateVariables["homework_submitted_teacher"];
      return {
        title: es ? "Tarea entregada" : "Homework submitted",
        body: v.assignmentTitle
          ? es
            ? `${v.studentName} entregó “${v.assignmentTitle}”.`
            : `${v.studentName} submitted “${v.assignmentTitle}”.`
          : es
            ? `${v.studentName} entregó una tarea.`
            : `${v.studentName} submitted homework.`,
        deepLink: v.dashboardPathSuffix,
        deepLinkName: v.studentName,
      };
    }
  }
  const _exhaustive: never = templateName;
  throw new Error(`unhandled template ${_exhaustive}`);
}

// ---------------------------------------------------------------------------
// Push channel routing
// ---------------------------------------------------------------------------

// Urgency class for a template's push. "booking" is reserved for calendar
// changes the recipient needs to notice right away — booking confirmed/
// canceled/rescheduled and imminent-class reminders — and Web Push sends those
// with `urgent` set. Every other template rides "default" so high-frequency or
// low-urgency sends (chat, receipts, nudges) don't cause notification fatigue.
export type PushChannel = "booking" | "default";

const BOOKING_CHANNEL_TEMPLATES: ReadonlySet<TemplateName> = new Set<TemplateName>([
  "booking_confirmation",
  "cancel_lt24h",
  "cancel_gte24h_with_reschedule",
  "teacher_cancel",
  "reschedule_confirm",
  "reminder_1h",
  "reminder_15m",
  "reminder_1h_teacher",
  "reminder_15m_teacher",
  "no_show_student",
  "booking_created_teacher",
  "cancel_lt24h_teacher",
  "cancel_gte24h_teacher",
  "reschedule_confirm_teacher",
]);

export function pushChannelForTemplate(templateName: TemplateName): PushChannel {
  return BOOKING_CHANNEL_TEMPLATES.has(templateName) ? "booking" : "default";
}
