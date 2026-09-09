import { describe, expect, it } from "vitest";
import { renderEmail } from "@/lib/email/templates";
import { renderPush } from "@/lib/notifications/push";
import { urlButtonSuffix } from "@/lib/notifications/templates";

// Copy for a LOST CHARGEBACK, in both languages and on both channels.
//
// The dispute branch used to revoke the student's remaining classes and take
// the money out of the teacher's balance while telling neither of them. These
// two templates are what it says now, and the point of this suite is the one
// thing that could go quietly wrong with them: reusing the refund wording.
// Nothing was refunded — the money did not come back voluntarily and the
// classes are gone rather than returned — so the copy must not say it did, and
// must not accuse anybody of anything either. A chargeback is raised with a
// card issuer, the outcome is the issuer's, and a genuine billing mix-up is
// indistinguishable from here.

const STUDENT_VARS = {
  teacherName: "Alicia Moreno",
  packageName: "Individual class",
  amount: "$500.00 MXN",
  portalPathSuffix: "my-classes",
};

const TEACHER_VARS = {
  teacherName: "Alicia Moreno",
  studentName: "Jay",
  packageName: "Individual class",
  amount: "$500.00 MXN",
  paymentPathSuffix: "payments/p1",
};

describe("dispute_lost_student email", () => {
  it("renders Spanish without calling it a refund", () => {
    const r = renderEmail({
      templateName: "dispute_lost_student",
      languageCode: "es_MX",
      variables: STUDENT_VARS,
      actionUrl: null,
    });
    expect(r.subject).toContain("Se revirtió tu pago");
    expect(r.body).toContain("$500.00 MXN");
    expect(r.body).toContain("Individual class");
    expect(r.body.toLowerCase()).not.toContain("reembols");
    expect(r.html).toContain("Se revirtió tu pago");
  });

  it("renders English without calling it a refund", () => {
    const r = renderEmail({
      templateName: "dispute_lost_student",
      languageCode: "en",
      variables: STUDENT_VARS,
      actionUrl: null,
    });
    expect(r.subject).toContain("Your payment was reversed");
    expect(r.body).toContain("$500.00 MXN");
    expect(r.body.toLowerCase()).not.toContain("refund");
    expect(r.html).toContain("Your payment was reversed");
  });

  it("tells her the classes are gone, and offers a way to contest it", () => {
    const es = renderEmail({
      templateName: "dispute_lost_student",
      languageCode: "es_MX",
      variables: STUDENT_VARS,
      actionUrl: null,
    });
    const en = renderEmail({
      templateName: "dispute_lost_student",
      languageCode: "en",
      variables: STUDENT_VARS,
      actionUrl: null,
    });
    expect(es.body).toContain("ya no están disponibles");
    expect(es.body).toContain("error");
    expect(en.body).toContain("no longer available");
    expect(en.body).toContain("mistake");
  });

  it("carries no action button — there is nothing for her to do from an email", () => {
    expect(urlButtonSuffix("dispute_lost_student", STUDENT_VARS)).toBeNull();
  });
});

describe("dispute_lost_teacher email", () => {
  it("names the student, the amount and the fee, in Spanish", () => {
    const r = renderEmail({
      templateName: "dispute_lost_teacher",
      languageCode: "es_MX",
      variables: TEACHER_VARS,
      actionUrl: "https://spiralclass.com/payments/p1",
    });
    expect(r.subject).toContain("Contracargo perdido");
    expect(r.body).toContain("Jay");
    expect(r.body).toContain("$500.00 MXN");
    // She is the merchant of record (D-143) — the money came out of HER
    // balance, and the copy has to say so or she will look for it elsewhere.
    expect(r.body).toContain("de tu saldo");
    expect(r.body).toContain("comisión por contracargo");
    expect(r.body.toLowerCase()).not.toContain("reembols");
  });

  it("names the student, the amount and the fee, in English", () => {
    const r = renderEmail({
      templateName: "dispute_lost_teacher",
      languageCode: "en",
      variables: TEACHER_VARS,
      actionUrl: "https://spiralclass.com/payments/p1",
    });
    expect(r.subject).toContain("Chargeback lost");
    expect(r.body).toContain("Jay");
    expect(r.body).toContain("out of your balance");
    expect(r.body).toContain("dispute fee");
    expect(r.body.toLowerCase()).not.toContain("refund");
  });

  it("links to the payment", () => {
    expect(urlButtonSuffix("dispute_lost_teacher", TEACHER_VARS)).toBe("payments/p1");
  });
});

describe("dispute_lost push", () => {
  it("renders both recipients in both languages", () => {
    expect(renderPush("dispute_lost_student", "es_MX", STUDENT_VARS)).toMatchObject({
      title: "Se revirtió tu pago",
      deepLink: "my-classes",
    });
    expect(renderPush("dispute_lost_student", "en", STUDENT_VARS).title).toBe(
      "Your payment was reversed",
    );
    expect(renderPush("dispute_lost_teacher", "es_MX", TEACHER_VARS)).toMatchObject({
      title: "Contracargo perdido",
      deepLink: "payments/p1",
    });
    expect(renderPush("dispute_lost_teacher", "en", TEACHER_VARS).title).toBe("Chargeback lost");
  });

  it("carries the amount, so the notification is legible without opening it", () => {
    expect(renderPush("dispute_lost_student", "en", STUDENT_VARS).body).toContain("$500.00 MXN");
    expect(renderPush("dispute_lost_teacher", "en", TEACHER_VARS).body).toContain("$500.00 MXN");
  });

  it("falls back cleanly when the student has no portal path", () => {
    const { portalPathSuffix: _omitted, ...withoutPath } = STUDENT_VARS;
    expect(renderPush("dispute_lost_student", "en", withoutPath).deepLink).toBeNull();
  });
});
