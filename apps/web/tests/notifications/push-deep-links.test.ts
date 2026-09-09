import { describe, expect, it } from "vitest";
import { renderPush } from "@/lib/notifications/push";

// These templates carried `deepLink: null` even though the dispatcher already
// computed a usable path suffix (or could trivially do so) — tapping the
// notification did nothing. Each case below pins the deep-link the renderer
// should now emit.

describe("renderPush — deep links that used to be dropped", () => {
  it("cancel_lt24h_teacher deep-links to the booking detail when available", () => {
    const rendered = renderPush("cancel_lt24h_teacher", "es_MX", {
      teacherName: "Alicia Moreno",
      studentName: "Beto",
      originalDateTime: "martes 10:00",
      dashboardPathSuffix: "dashboard/classes/b1",
    });
    expect(rendered.deepLink).toBe("dashboard/classes/b1");
  });

  it("cancel_lt24h_teacher falls back to null without a booking", () => {
    const rendered = renderPush("cancel_lt24h_teacher", "es_MX", {
      teacherName: "Alicia Moreno",
      studentName: "Beto",
      originalDateTime: "martes 10:00",
    });
    expect(rendered.deepLink).toBeNull();
  });

  it("package_expiry_nudge prefers the in-app book tab over the public booking page", () => {
    const rendered = renderPush("package_expiry_nudge", "es_MX", {
      teacherName: "Alicia Moreno",
      packageName: "Paquete 10 clases",
      classesRemaining: "3",
      expiryDate: "1 jul 2026",
      bookingLinkPathSuffix: "b/alicia-moreno",
      bookPathSuffix: "s/book",
    });
    expect(rendered.deepLink).toBe("s/book");
  });

  it("package_expiry_nudge falls back to the public booking page without bookPathSuffix", () => {
    const rendered = renderPush("package_expiry_nudge", "es_MX", {
      teacherName: "Alicia Moreno",
      packageName: "Paquete 10 clases",
      classesRemaining: "3",
      expiryDate: "1 jul 2026",
      bookingLinkPathSuffix: "b/alicia-moreno",
    });
    expect(rendered.deepLink).toBe("b/alicia-moreno");
  });

  it("no_show_student deep-links to the class detail when available", () => {
    const rendered = renderPush("no_show_student", "es_MX", {
      teacherName: "Alicia Moreno",
      originalDateTime: "martes 10:00",
      classPathSuffix: "s/class/b1",
    });
    expect(rendered.deepLink).toBe("s/class/b1");
  });

  it("refund_issued_student deep-links to the portal when available", () => {
    const rendered = renderPush("refund_issued_student", "es_MX", {
      teacherName: "Alicia Moreno",
      packageName: "Paquete 10 clases",
      amount: "$1,990.00",
      portalPathSuffix: "my-classes",
    });
    expect(rendered.deepLink).toBe("my-classes");
  });

  it("wise_marked_sent_student deep-links to the portal when available", () => {
    const rendered = renderPush("wise_marked_sent_student", "es_MX", {
      teacherName: "Alicia Moreno",
      packageName: "Paquete 10 clases",
      wiseReference: "REF123",
      portalPathSuffix: "my-classes",
    });
    expect(rendered.deepLink).toBe("my-classes");
  });
});

describe("renderPush — chat deep links carry the counterpart's name", () => {
  // The chat deep link (`s/messages/<teacherId>` / `t/messages/<studentId>`)
  // lands on a dynamic-segment screen a client can't otherwise label — the
  // thread header reads the name off nav params. Without deepLinkName here,
  // the dispatcher has nothing to forward in the push `data` payload and the
  // header falls back to a generic "Chat" title.
  it("chat_message (student recipient) carries the teacher's name", () => {
    const rendered = renderPush("chat_message", "es_MX", {
      teacherName: "Alicia Moreno",
      preview: "Hola, ¿cómo estás?",
      chatPathSuffix: "s/messages/t1",
    });
    expect(rendered.deepLink).toBe("s/messages/t1");
    expect(rendered.deepLinkName).toBe("Alicia Moreno");
  });

  it("chat_message_teacher (teacher recipient) carries the student's name", () => {
    const rendered = renderPush("chat_message_teacher", "es_MX", {
      teacherName: "Alicia Moreno",
      studentName: "Beto",
      preview: "Hola, ¿cómo estás?",
      chatPathSuffix: "t/messages/s1",
    });
    expect(rendered.deepLink).toBe("t/messages/s1");
    expect(rendered.deepLinkName).toBe("Beto");
  });
});
