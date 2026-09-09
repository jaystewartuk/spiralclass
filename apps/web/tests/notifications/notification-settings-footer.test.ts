import { describe, expect, it } from "vitest";
import { renderEmail } from "@/lib/email/templates";

// Every notification email carries a "notification settings" footer link —
// unlike the unsubscribe link (student-only, suppressed for teacher sends),
// this one is sent to teacher and student recipients alike.

const NOTIF_URL = "https://spiralclass.com/r/notif-settings/abc123.def456";
const UNSUB_URL = "https://spiralclass.com/r/email-uns/xyz789.uvw012";

describe("renderEmail — notification settings footer", () => {
  it("appends the notification-settings line to the text body (es-MX)", () => {
    const r = renderEmail({
      templateName: "payment_received",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        packageName: "10 clases",
        amount: "$1,000.00 MXN",
        portalPathSuffix: "/my-classes",
      },
      actionUrl: null,
      notificationSettingsUrl: NOTIF_URL,
    });
    expect(r.body).toContain(`Configurar notificaciones: ${NOTIF_URL}`);
    expect(r.html).toContain(NOTIF_URL);
    expect(r.html).toContain("Configurar notificaciones");
  });

  it("appends the English variant", () => {
    const r = renderEmail({
      templateName: "payment_received",
      languageCode: "en",
      variables: {
        teacherName: "Mira",
        packageName: "10 classes",
        amount: "$1,000.00 MXN",
        portalPathSuffix: "/my-classes",
      },
      actionUrl: null,
      notificationSettingsUrl: NOTIF_URL,
    });
    expect(r.body).toContain(`Manage notification settings: ${NOTIF_URL}`);
    expect(r.html).toContain("Manage notification settings");
  });

  it("renders both the notification-settings and unsubscribe links together, on separate lines", () => {
    const r = renderEmail({
      templateName: "payment_received",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        packageName: "10 clases",
        amount: "$1,000.00 MXN",
        portalPathSuffix: "/my-classes",
      },
      actionUrl: null,
      notificationSettingsUrl: NOTIF_URL,
      unsubscribeUrl: UNSUB_URL,
    });
    expect(r.body).toContain(NOTIF_URL);
    expect(r.body).toContain(UNSUB_URL);
    expect(r.body.indexOf(NOTIF_URL)).toBeLessThan(r.body.indexOf(UNSUB_URL));
    expect(r.html).toContain(NOTIF_URL);
    expect(r.html).toContain(UNSUB_URL);
  });

  it("omits the link entirely when notificationSettingsUrl is absent (existing one-off emails unaffected)", () => {
    const r = renderEmail({
      templateName: "payment_received",
      languageCode: "es_MX",
      variables: {
        teacherName: "Mira",
        packageName: "10 clases",
        amount: "$1,000.00 MXN",
        portalPathSuffix: "/my-classes",
      },
      actionUrl: null,
    });
    expect(r.body).not.toContain("Configurar notificaciones");
    expect(r.html).not.toContain("Configurar notificaciones");
  });
});
