import { describe, expect, it } from "vitest";
import { renderEmail } from "@/lib/email/templates";

// The payment receipt / class reminders / — every notification template has both an es-MX
// and an en branch. Existing `templates.test.ts` covers Meta-side
// variable ordering; this file pins the email fallback copy across all
// 11 templates so a regression in subject/body interpolation surfaces
// immediately. Particular focus on the receipt path which the
// audit flagged as "renders Spanish + English copy" but had no test.

describe("renderEmail — calendar link (Phase 2)", () => {
  const calendarUrl =
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Clase+con+Mira&dates=20260615T160000Z%2F20260615T165000Z";

  it("adds an 'Add to calendar' link to the booking confirmation when supplied", () => {
    const r = renderEmail({
      templateName: "booking_confirmation",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        classDateTime: "lunes 15 junio 10:00",
        classesRemaining: "7",
      },
      actionUrl: null,
      calendarUrl,
    });
    expect(r.body).toContain(`Agregar a calendario: ${calendarUrl}`);
    // The href is HTML-attribute-escaped (& → &amp;), so match the escaped form.
    expect(r.html).toContain(
      "https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Clase+con+Mira",
    );
    expect(r.html).toContain("Agregar a calendario");
  });

  it("localizes the label and link for the English reminder", () => {
    const r = renderEmail({
      templateName: "reminder_24h",
      languageCode: "en",
      variables: { teacherName: "Mira", classDateTime: "Mon 15 Jun 10:00" },
      actionUrl: null,
      calendarUrl,
    });
    expect(r.body).toContain(`Add to calendar: ${calendarUrl}`);
    expect(r.html).toContain("Add to calendar");
  });

  it("omits the link entirely when no calendarUrl is supplied", () => {
    const r = renderEmail({
      templateName: "booking_confirmation",
      languageCode: "en",
      variables: { teacherName: "Mira", classDateTime: "Mon 15 Jun 10:00", classesRemaining: "7" },
      actionUrl: null,
    });
    expect(r.body).not.toContain("Add to calendar");
    expect(r.html).not.toContain("Add to calendar");
  });
});

describe("renderEmail — payment_received (receipt, the payment receipt)", () => {
  it("renders the Spanish receipt with package name + amount + teacher voice", () => {
    const r = renderEmail({
      templateName: "payment_received",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        packageName: "8 clases / mes",
        amount: "$2,400.00",
        portalPathSuffix: "/my-classes",
      },
      actionUrl: "https://app.test/my-classes",
    });
    expect(r.subject).toBe("Pago recibido — Alicia Moreno");
    expect(r.body).toMatch(/Hola, soy Alicia Moreno/);
    expect(r.body).toMatch(/Recibí tu pago por 8 clases \/ mes \(\$2,400\.00\)/);
    expect(r.body).toMatch(/Tu paquete ya está activo/);
    expect(r.body).toMatch(/https:\/\/app\.test\/my-classes/);
  });

  it("renders the English receipt with the same variables substituted", () => {
    const r = renderEmail({
      templateName: "payment_received",
      languageCode: "en",
      variables: {
        teacherName: "Alicia Moreno",
        packageName: "8 classes / month",
        amount: "$2,400.00 MXN",
        portalPathSuffix: "/my-classes",
      },
      actionUrl: "https://app.test/my-classes",
    });
    expect(r.subject).toBe("Payment received — Alicia Moreno");
    expect(r.body).toMatch(/Hi, I'm Alicia Moreno/);
    expect(r.body).toMatch(/Got your payment for 8 classes \/ month/);
    expect(r.body).toMatch(/Your package is active/);
    expect(r.body).toMatch(/https:\/\/app\.test\/my-classes/);
  });

  it("falls back to '(pendiente)' / '(pending)' when actionUrl is null", () => {
    const es = renderEmail({
      templateName: "payment_received",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        packageName: "X",
        amount: "$0",
        portalPathSuffix: "/p",
      },
      actionUrl: null,
    });
    expect(es.body).toMatch(/\(pendiente\)/);

    const en = renderEmail({
      templateName: "payment_received",
      languageCode: "en",
      variables: {
        teacherName: "Mira",
        packageName: "X",
        amount: "$0",
        portalPathSuffix: "/p",
      },
      actionUrl: null,
    });
    expect(en.body).toMatch(/\(pending\)/);
  });
});

describe("renderEmail — booking_confirmation", () => {
  it("renders both locales with classesRemaining and a WhatsApp meet line", () => {
    const vars = {
      teacherName: "Mira",
      classDateTime: "lunes 11 mayo 10:00",
      classesRemaining: "7",
    };
    const es = renderEmail({
      templateName: "booking_confirmation",
      languageCode: "es_MX",
      variables: vars,
      actionUrl: null,
    });
    expect(es.subject).toMatch(/clase con Mira está confirmada/);
    expect(es.body).toMatch(/lunes 11 mayo 10:00/);
    expect(es.body).toMatch(/Te quedan 7 clases/);
    expect(es.body).toMatch(/Nos conectamos por WhatsApp/);

    const en = renderEmail({
      templateName: "booking_confirmation",
      languageCode: "en",
      variables: { ...vars, classDateTime: "Mon May 11 10:00 AM" },
      actionUrl: null,
    });
    expect(en.subject).toMatch(/class with Mira is confirmed/);
    expect(en.body).toMatch(/You have 7 classes left/);
    expect(en.body).toMatch(/We'll meet on WhatsApp/);
  });

  it("swaps the WhatsApp line for a video-call button when a join URL is given (D-16)", () => {
    const vars = {
      teacherName: "Mira",
      classDateTime: "lunes 11 mayo 10:00",
      classesRemaining: "7",
    };
    const es = renderEmail({
      templateName: "booking_confirmation",
      languageCode: "es_MX",
      variables: vars,
      actionUrl: "https://app.test/my-classes/b1/call",
    });
    // call copy replaces the WhatsApp line; URL appears in text + as an html button
    expect(es.body).toMatch(/Entra a la videollamada/);
    expect(es.body).not.toMatch(/WhatsApp/);
    expect(es.body).toContain("https://app.test/my-classes/b1/call");
    expect(es.html).toMatch(/Entrar a la videollamada/);
    expect(es.html).toContain("https://app.test/my-classes/b1/call");

    const en = renderEmail({
      templateName: "booking_confirmation",
      languageCode: "en",
      variables: { ...vars, classDateTime: "Mon May 11 10:00 AM" },
      actionUrl: "https://app.test/my-classes/b1/call",
    });
    expect(en.body).toMatch(/Join the video call/);
    expect(en.body).not.toMatch(/WhatsApp/);
    expect(en.html).toMatch(/Join video call/);
  });
});

describe("renderEmail — reminder_1h join link", () => {
  it("keeps the inline WhatsApp copy without a call URL, and switches with one", () => {
    const base = {
      templateName: "reminder_1h" as const,
      languageCode: "es_MX" as const,
      variables: { teacherName: "Mira", classDateTime: "10:00" },
    };
    const whatsapp = renderEmail({ ...base, actionUrl: null });
    expect(whatsapp.body).toMatch(/por WhatsApp/);

    const call = renderEmail({ ...base, actionUrl: "https://app.test/my-classes/b1/call" });
    expect(call.body).not.toMatch(/WhatsApp/);
    expect(call.body).toMatch(/Entra a la videollamada/);
    expect(call.body).toContain("https://app.test/my-classes/b1/call");
  });
});

describe("renderEmail — reminder_24h", () => {
  it("tells the student to expect WhatsApp at the class time (es-MX)", () => {
    const r = renderEmail({
      templateName: "reminder_24h",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        classDateTime: "mañana 10:00",
      },
      actionUrl: null,
    });
    expect(r.body).toMatch(/Nos conectamos por WhatsApp/);
  });

  it("English variant carries the same WhatsApp meet line", () => {
    const r = renderEmail({
      templateName: "reminder_24h",
      languageCode: "en",
      variables: {
        teacherName: "Mira",
        classDateTime: "tomorrow 10:00",
      },
      actionUrl: null,
    });
    expect(r.body).toMatch(/We'll meet on WhatsApp/);
  });
});

describe("renderEmail — teacher reminders (teacher-voiced, names the student)", () => {
  it("24h teacher reminder names the student and omits the WhatsApp line with no call", () => {
    const r = renderEmail({
      templateName: "reminder_24h_teacher",
      languageCode: "es_MX",
      variables: { studentName: "Mariana", classDateTime: "mañana 10:00" },
      actionUrl: null,
    });
    expect(r.subject).toBe("Recordatorio: clase mañana con Mariana");
    expect(r.body).toMatch(/Te recuerdo tu clase con Mariana mañana/);
    // Brand-new teacher copy must not carry the stale WhatsApp fallback.
    expect(r.body).not.toMatch(/WhatsApp/);
  });

  it("1h teacher reminder surfaces the teacher's join link when a call is available (en)", () => {
    const r = renderEmail({
      templateName: "reminder_1h_teacher",
      languageCode: "en",
      variables: { studentName: "Mariana", classDateTime: "10:00" },
      actionUrl: "https://app.test/dashboard/classes/b1/call",
    });
    expect(r.subject).toBe("Class with Mariana starts in 1 hour");
    expect(r.body).toMatch(/Join the video call/);
    expect(r.body).toContain("https://app.test/dashboard/classes/b1/call");
  });

  it("5m teacher reminder names the student (en)", () => {
    const r = renderEmail({
      templateName: "reminder_15m_teacher",
      languageCode: "en",
      variables: { studentName: "Mariana", classDateTime: "10:00" },
      actionUrl: null,
    });
    expect(r.body).toMatch(/Your class with Mariana starts in 15 minutes/);
  });
});

describe("renderEmail — cancel_lt24h vs cancel_gte24h_with_reschedule", () => {
  it("cancel_lt24h communicates the deduction rule without a reschedule link", () => {
    const r = renderEmail({
      templateName: "cancel_lt24h",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        originalDateTime: "ayer 10:00",
      },
      actionUrl: null,
    });
    expect(r.body).toMatch(/menos de 24h/);
    expect(r.body).toMatch(/se descuenta del paquete/);
    // No reschedule link variable in this template.
    expect(r.body).not.toMatch(/Reagenda:/);
  });

  it("cancel_gte24h_with_reschedule offers a reschedule link", () => {
    const r = renderEmail({
      templateName: "cancel_gte24h_with_reschedule",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        originalDateTime: "ayer 10:00",
        reschedulePathSuffix: "/reschedule",
      },
      actionUrl: "https://app.test/reschedule",
    });
    expect(r.body).toMatch(/Reagenda: https:\/\/app\.test\/reschedule/);
  });
});

describe("renderEmail — magic_link", () => {
  it("includes the expiry-minutes and the action_link", () => {
    const r = renderEmail({
      templateName: "magic_link",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        expiryMinutes: "30",
        magicLinkPathSuffix: "/r/ml/xyz",
      },
      actionUrl: "https://supabase.test/magic#token",
    });
    expect(r.body).toMatch(/30 minutos/);
    expect(r.body).toMatch(/https:\/\/supabase\.test\/magic#token/);
  });
});

describe("renderEmail — materials_send", () => {
  it("includes the class date and a download URL", () => {
    const r = renderEmail({
      templateName: "materials_send",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        classDateTime: "mañana 10:00",
        materialsPathSuffix: "/m/abc",
      },
      actionUrl: "https://supabase.test/material",
    });
    expect(r.body).toMatch(/material para la clase del mañana 10:00/i);
    expect(r.body).toMatch(/Descarga: https:\/\/supabase\.test\/material/);
  });
});

describe("renderEmail — library_material_assigned (account-level material)", () => {
  it("names the material and links to the student materials page", () => {
    const r = renderEmail({
      templateName: "library_material_assigned",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        materialLabel: "Unidad 3 — lectura",
        materialsPathSuffix: "mis-clases/materials",
      },
      actionUrl: "https://app.test/my-classes/materials",
    });
    expect(r.body).toMatch(/material nuevo: "Unidad 3 — lectura"/i);
    expect(r.body).toMatch(/https:\/\/app\.test\/my-classes\/materials/);
  });

  it("renders English copy with the same substitution surface", () => {
    const r = renderEmail({
      templateName: "library_material_assigned",
      languageCode: "en",
      variables: {
        teacherName: "Mira",
        materialLabel: "Unit 3 — reading",
        materialsPathSuffix: "mis-clases/materials",
      },
      actionUrl: "https://app.test/my-classes/materials",
    });
    expect(r.subject).toBe("New material — Mira");
    expect(r.body).toMatch(/new material: "Unit 3 — reading"/i);
  });
});

describe("renderEmail — payment_pending_teacher (teacher email-only)", () => {
  it("renders Spanish copy addressed to the teacher with the Wise reference", () => {
    const r = renderEmail({
      templateName: "payment_pending_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        packageName: "8 clases / mes",
        amount: "$2,400.00",
        wiseReference: "AGP-1A2B3C4D",
        paymentPathSuffix: "payments/abc",
      },
      actionUrl: "https://app.test/payments/abc",
    });
    expect(r.subject).toBe("Pago Wise pendiente — Mariana");
    expect(r.body).toMatch(/Hola Alicia Moreno/);
    expect(r.body).toMatch(/Mariana acaba de iniciar la compra de 8 clases \/ mes por \$2,400\.00/);
    expect(r.body).toMatch(/AGP-1A2B3C4D/);
    expect(r.body).toMatch(/https:\/\/app\.test\/payments\/abc/);
  });

  it("renders English copy with the same substitution surface", () => {
    const r = renderEmail({
      templateName: "payment_pending_teacher",
      languageCode: "en",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        packageName: "8 classes / month",
        amount: "$2,400.00 MXN",
        wiseReference: "AGP-1A2B3C4D",
        paymentPathSuffix: "payments/abc",
      },
      actionUrl: "https://app.test/payments/abc",
    });
    expect(r.subject).toBe("Wise payment pending — Mariana");
    expect(r.body).toMatch(/Hi Alicia Moreno/);
    expect(r.body).toMatch(/Mariana just started buying 8 classes \/ month/);
  });
});

describe("renderEmail — payment_marked_sent_teacher (teacher email-only)", () => {
  it("nudges the teacher to confirm in Wise with the reference visible", () => {
    const r = renderEmail({
      templateName: "payment_marked_sent_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        packageName: "Paquete chico",
        amount: "$1,300.00",
        wiseReference: "AGP-EDD629F8",
        paymentPathSuffix: "payments/xyz",
      },
      actionUrl: "https://app.test/payments/xyz",
    });
    expect(r.subject).toBe("Mariana dice que ya envió el pago Wise");
    expect(r.body).toMatch(/Mariana marcó como enviada la transferencia de \$1,300\.00/);
    expect(r.body).toMatch(/AGP-EDD629F8/);
    expect(r.body).toMatch(/https:\/\/app\.test\/payments\/xyz/);
  });
});

// --- Audit P1/P2 (2026-05-27) additions --------------------------------------

describe("renderEmail — payment_failed_student", () => {
  it("explains that the payment didn't go through + gives a retry link", () => {
    const r = renderEmail({
      templateName: "payment_failed_student",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        packageName: "8 clases / mes",
        retryPathSuffix: "b/alicia-moreno",
      },
      actionUrl: "https://app.test/b/alicia-moreno",
    });
    expect(r.subject).toBe("Tu pago no se completó — Alicia Moreno");
    expect(r.body).toMatch(/no se pudo procesar/);
    expect(r.body).toMatch(/https:\/\/app\.test\/b\/alicia-moreno/);
  });
});

describe("renderEmail — refund_issued_student + refund_issued_teacher", () => {
  it("student copy confirms the refund + amount", () => {
    const r = renderEmail({
      templateName: "refund_issued_student",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        packageName: "Paquete chico",
        amount: "$1,300.00",
      },
      actionUrl: null,
    });
    expect(r.subject).toMatch(/Reembolso emitido/);
    expect(r.body).toMatch(/\$1,300\.00/);
  });

  it("teacher copy points to the payment detail page", () => {
    const r = renderEmail({
      templateName: "refund_issued_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        packageName: "Paquete chico",
        amount: "$1,300.00",
        paymentPathSuffix: "payments/abc",
      },
      actionUrl: "https://app.test/payments/abc",
    });
    expect(r.subject).toBe("Reembolso emitido — Mariana");
    expect(r.body).toMatch(/reembolso de \$1,300\.00 a Mariana/);
    expect(r.body).toMatch(/https:\/\/app\.test\/payments\/abc/);
  });
});

describe("renderEmail — stripe_ready_teacher + stripe_requirements_teacher", () => {
  it("ready copy unblocks the teacher with their booking link", () => {
    const r = renderEmail({
      templateName: "stripe_ready_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        bookingLinkPathSuffix: "b/alicia-moreno",
      },
      actionUrl: "https://app.test/b/alicia-moreno",
    });
    expect(r.subject).toBe("Tu Stripe ya está listo");
    expect(r.body).toMatch(/ya puedes cobrar pagos con tarjeta/);
    expect(r.body).toMatch(/https:\/\/app\.test\/b\/alicia-moreno/);
  });

  it("requirements copy nudges the teacher to fix onboarding", () => {
    const r = renderEmail({
      templateName: "stripe_requirements_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        stripeSettingsPathSuffix: "settings/payments",
      },
      actionUrl: "https://app.test/settings/payments",
    });
    expect(r.subject).toBe("Stripe necesita información adicional");
    expect(r.body).toMatch(/Stripe pausó los cobros con tarjeta/);
  });
});

describe("renderEmail — account_disabled_teacher", () => {
  it("includes the moderation reason verbatim", () => {
    const r = renderEmail({
      templateName: "account_disabled_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        reason: "Múltiples reportes de cobros indebidos.",
      },
      actionUrl: null,
    });
    expect(r.subject).toMatch(/deshabilitada/i);
    expect(r.body).toMatch(/Múltiples reportes de cobros indebidos/);
  });
});

describe("renderEmail — no_show_student", () => {
  it("informs the student a class was deducted, linking the cancellation policy", () => {
    const r = renderEmail({
      templateName: "no_show_student",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        originalDateTime: "lunes 10 de febrero, 10:00",
      },
      actionUrl: null,
      appUrl: "https://app.test",
    });
    expect(r.subject).toMatch(/no asistencia/);
    expect(r.body).toMatch(/política de cancelaciones/);
    expect(r.body).toMatch(/https:\/\/app\.test\/terms#cancelaciones/);
    // No spec section number, of any kind. This asserted `/§6\.6/` alone,
    // written when that exact citation shipped to a student; the rule is that
    // an internal section number is meaningless to a recipient, so guard the
    // rule rather than the one token that broke it.
    expect(r.body).not.toMatch(/§\d/);
    expect(r.body).toMatch(/lunes 10 de febrero, 10:00/);
  });
});

describe("renderEmail — wise_marked_sent_student (review item 6)", () => {
  it("acknowledges the student's mark-sent click and sets expectations", () => {
    const r = renderEmail({
      templateName: "wise_marked_sent_student",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        packageName: "8 clases",
        wiseReference: "AGP-1A2B3C4D",
      },
      actionUrl: null,
    });
    expect(r.subject).toBe("Recibimos tu aviso de pago");
    expect(r.body).toMatch(/AGP-1A2B3C4D/);
    expect(r.body).toMatch(/tu paquete queda activo/);
  });
});

describe("renderEmail — payment_received_teacher (review item 7)", () => {
  it("tells the teacher about a card sale with a payment link", () => {
    const r = renderEmail({
      templateName: "payment_received_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        packageName: "8 clases",
        amount: "$2,000.00",
        paymentPathSuffix: "payments/p1",
      },
      actionUrl: "https://app.test/payments/p1",
    });
    expect(r.subject).toBe("Nueva venta — Mariana compró 8 clases");
    expect(r.body).toMatch(/Mariana compró 8 clases por \$2,000\.00 con tarjeta/);
    expect(r.body).toMatch(/https:\/\/app\.test\/payments\/p1/);
  });
});

describe("renderEmail — teacher mirrors for booking/cancel/reschedule", () => {
  it("booking_created_teacher carries the student name + dashboard link", () => {
    const r = renderEmail({
      templateName: "booking_created_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        classDateTime: "lunes 10 de febrero, 10:00",
        dashboardPathSuffix: "dashboard/classes/abc",
      },
      actionUrl: "https://app.test/dashboard/classes/abc",
    });
    expect(r.subject).toBe("Nueva clase reservada — Mariana");
    expect(r.body).toMatch(/Mariana reservó una clase para el lunes 10 de febrero, 10:00/);
  });

  it("cancel_lt24h_teacher highlights the late-cancellation rule, linking the policy", () => {
    const r = renderEmail({
      templateName: "cancel_lt24h_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        originalDateTime: "lunes 10 de febrero, 10:00",
      },
      actionUrl: null,
      appUrl: "https://app.test",
    });
    expect(r.subject).toMatch(/Mariana canceló con menos de 24h/);
    expect(r.body).toMatch(/se descontó del paquete según la política de cancelaciones/);
    expect(r.body).toMatch(/https:\/\/app\.test\/terms#cancelaciones/);
    expect(r.html).toMatch(/Ver política de cancelaciones/);
    // No archived note unless the flag is set.
    expect(r.body).not.toMatch(/dado de baja/);
  });

  it("cancel_lt24h_teacher tells the teacher when the student's notice was suppressed (archived)", () => {
    const r = renderEmail({
      templateName: "cancel_lt24h_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        originalDateTime: "lunes 10 de febrero, 10:00",
        studentArchived: true,
      },
      actionUrl: null,
      appUrl: "https://app.test",
    });
    expect(r.body).toMatch(/Mariana no recibió ningún aviso de esta cancelación/);
    expect(r.body).toMatch(/dado de baja/);
    expect(r.html).toMatch(/dado de baja/);
  });

  it("cancel_gte24h_teacher carries the archived note too", () => {
    const r = renderEmail({
      templateName: "cancel_gte24h_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        originalDateTime: "lunes 10 de febrero, 10:00",
        studentArchived: true,
      },
      actionUrl: null,
    });
    expect(r.subject).toMatch(/Mariana canceló su clase/);
    expect(r.body).toMatch(/dado de baja/);
  });

  it("reschedule_confirm_teacher shows old → new", () => {
    const r = renderEmail({
      templateName: "reschedule_confirm_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        oldDateTime: "lunes 10:00",
        newDateTime: "martes 11:00",
      },
      actionUrl: null,
    });
    expect(r.subject).toBe("Mariana reagendó su clase");
    expect(r.body).toMatch(/lunes 10:00 al martes 11:00/);
  });
});

describe("renderEmail — package_consumed_student (renewal nudge)", () => {
  it("renders Spanish copy in the teacher's voice with the portal repurchase link", () => {
    const r = renderEmail({
      templateName: "package_consumed_student",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        packageName: "10 clases",
        renewPathSuffix: "mis-clases/buy",
      },
      actionUrl: "https://app.test/my-classes/buy",
    });
    expect(r.subject).toBe("Ya usaste todas tus clases con Alicia Moreno");
    expect(r.body).toMatch(/Hola, soy Alicia Moreno/);
    expect(r.body).toMatch(/"10 clases"/);
    expect(r.body).toMatch(/https:\/\/app\.test\/my-classes\/buy/);
  });

  it("renders English copy with the same substitution surface", () => {
    const r = renderEmail({
      templateName: "package_consumed_student",
      languageCode: "en",
      variables: {
        teacherName: "Alicia Moreno",
        packageName: "10 classes",
        renewPathSuffix: "mis-clases/buy",
      },
      actionUrl: "https://app.test/my-classes/buy",
    });
    expect(r.subject).toBe("You've used all your classes with Alicia Moreno");
    expect(r.body).toMatch(/Hi, I'm Alicia Moreno/);
    expect(r.body).toMatch(/"10 classes"/);
    expect(r.body).toMatch(/https:\/\/app\.test\/my-classes\/buy/);
  });
});

describe("renderEmail — package_consumed_teacher (repeat-purchase heads-up)", () => {
  it("tells the teacher who finished which package", () => {
    const r = renderEmail({
      templateName: "package_consumed_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        packageName: "10 clases",
        studentPathSuffix: "dashboard/students/abc",
        studentNotified: true,
      },
      actionUrl: "https://app.test/dashboard/students/abc",
    });
    expect(r.subject).toBe("Mariana terminó su paquete");
    expect(r.body).toMatch(/Mariana ya usó todas las clases de su paquete "10 clases"/);
    expect(r.body).toMatch(/renovar/);
  });

  it("claims a student notice was sent only when studentNotified is true", () => {
    const r = renderEmail({
      templateName: "package_consumed_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        packageName: "10 clases",
        studentPathSuffix: "dashboard/students/abc",
        studentNotified: true,
      },
      actionUrl: "https://app.test/dashboard/students/abc",
    });
    expect(r.body).toMatch(/Le enviamos un aviso/);
  });

  it("drops the 'we told them' line when the student got no notice", () => {
    const r = renderEmail({
      templateName: "package_consumed_teacher",
      languageCode: "es_MX",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        packageName: "10 clases",
        studentPathSuffix: "dashboard/students/abc",
        studentNotified: false,
      },
      actionUrl: "https://app.test/dashboard/students/abc",
    });
    expect(r.body).not.toMatch(/Le enviamos un aviso/);
    expect(r.body).toMatch(/No recibe avisos automáticos nuestros/);
    // Still surfaces the renewal opportunity + WhatsApp follow-up.
    expect(r.body).toMatch(/WhatsApp/);
  });

  it("drops the 'we sent them a renewal link' line in English too", () => {
    const r = renderEmail({
      templateName: "package_consumed_teacher",
      languageCode: "en",
      variables: {
        teacherName: "Alicia Moreno",
        studentName: "Mariana",
        packageName: "10 classes",
        studentPathSuffix: "dashboard/students/abc",
        studentNotified: false,
      },
      actionUrl: "https://app.test/dashboard/students/abc",
    });
    expect(r.body).not.toMatch(/We sent them a renewal link/);
    expect(r.body).toMatch(/don't get automatic notices/);
  });
});
