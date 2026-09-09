import { describe, expect, it } from "vitest";
import {
  localeToLanguageCode,
  TEMPLATE_NAMES,
  urlButtonSuffix,
} from "@/lib/notifications/templates";

// Contract tests for the template variable shapers. These catch rename +
// reorder regressions that would otherwise break the email/push renderers'
// template matching at send time.

describe("localeToLanguageCode", () => {
  it("maps 'es-MX' → 'es_MX'", () => {
    expect(localeToLanguageCode("es-MX")).toBe("es_MX");
  });
  it("maps 'es' → 'es_MX' (default MX)", () => {
    expect(localeToLanguageCode("es")).toBe("es_MX");
  });
  it("maps 'en' → 'en'", () => {
    expect(localeToLanguageCode("en")).toBe("en");
  });
  it("maps 'en-US' → 'en' (we only submit plain en)", () => {
    expect(localeToLanguageCode("en-US")).toBe("en");
  });
});

describe("urlButtonSuffix", () => {
  it("booking_confirmation has no URL button by default, but a join link when set (D-16)", () => {
    expect(
      urlButtonSuffix("booking_confirmation", {
        teacherName: "Alicia Moreno",
        classDateTime: "lunes 10:00",
        classesRemaining: "18",
      }),
    ).toBeNull();
    expect(
      urlButtonSuffix("booking_confirmation", {
        teacherName: "Alicia Moreno",
        classDateTime: "lunes 10:00",
        classesRemaining: "18",
        joinPathSuffix: "mis-clases/b1/call",
      }),
    ).toBe("mis-clases/b1/call");
  });

  it("reminder_24h + reminder_1h: null by default, join link when set", () => {
    for (const t of ["reminder_24h", "reminder_1h"] as const) {
      expect(
        urlButtonSuffix(t, { teacherName: "Alicia Moreno", classDateTime: "lunes 10:00" }),
      ).toBeNull();
      expect(
        urlButtonSuffix(t, {
          teacherName: "Alicia Moreno",
          classDateTime: "lunes 10:00",
          joinPathSuffix: "mis-clases/b1/call",
        }),
      ).toBe("mis-clases/b1/call");
    }
  });

  it("teacher reminders: null by default, teacher join link when set", () => {
    for (const t of [
      "reminder_24h_teacher",
      "reminder_1h_teacher",
      "reminder_15m_teacher",
    ] as const) {
      expect(urlButtonSuffix(t, { studentName: "Diego", classDateTime: "lunes 10:00" })).toBeNull();
      expect(
        urlButtonSuffix(t, {
          studentName: "Diego",
          classDateTime: "lunes 10:00",
          joinPathSuffix: "dashboard/classes/b1/call",
        }),
      ).toBe("dashboard/classes/b1/call");
    }
  });

  it("cancel_lt24h has no URL button", () => {
    expect(
      urlButtonSuffix("cancel_lt24h", {
        teacherName: "Alicia Moreno",
        originalDateTime: "lunes 10:00",
      }),
    ).toBeNull();
  });

  it("reschedule_confirm has no URL button", () => {
    expect(
      urlButtonSuffix("reschedule_confirm", {
        teacherName: "Alicia Moreno",
        oldDateTime: "lunes 10:00",
        newDateTime: "martes 10:00",
      }),
    ).toBeNull();
  });
});

describe("TEMPLATE_NAMES", () => {
  it("has exactly 50 entries", () => {
    // 11 templates from the original slice +
    // 2 teacher email-only Wise templates (payment_pending/marked_sent) +
    // 11 audit-driven additions (P1 + P2) split across student-email-only
    // (4) and teacher-email-only (7) +
    // 1 pre-expiry nudge (2026-06-03, student email-only) +
    // 1 Wise confirm reminder (2026-06-04, teacher email-only) +
    // 1 Stripe sale notice (2026-06-10, teacher email-only) +
    // 1 Wise mark-sent student ack (2026-06-10, student email-only) +
    // 2 consumed-package renewal nudges (2026-06-10, student + teacher,
    //   both email-only) +
    // 5 subscription/monetization notices (2026-06-12, all teacher email-only) +
    // 1 library-material-assigned notice (2026-06-16, student email-only) +
    // 1 lesson-insights review nudge (Phase F, teacher email-only) +
    // 1 five-minute pre-class reminder (2026-06-28, student push/email) +
    // 1 Facebook-groups posting nudge (teacher email-only; its cron was retired
    //   by D-125, the template stays so historical rows still render) +
    // 1 weekly student-acquisition plan nudge (D-125, teacher email-only) +
    // 2 chat message notifications (2026-06-29, student + teacher push/email) +
    // 3 teacher pre-class reminders (2026-07-07, teacher push/email) +
    // 1 homework submitted (2026-07-20, teacher push/email) +
    // 1 homework assigned (docs/features/homework.md, student push/email) +
    // 1 homework feedback available (slice 4, student push/email) +
    // 2 homework due-soon/overdue reminders (slice 6, student push/email) +
    // 2 lost-chargeback notices (2026-09-02, student + teacher, email-only) —
    //   a lost dispute revoked the student's remaining classes and took the
    //   money out of the teacher's balance while telling neither of them
    // − the 2 five-day pre-class reminders (student + teacher), removed at
    //   teachers' request.
    expect(TEMPLATE_NAMES).toHaveLength(51);
  });

  it("carries no five-day pre-class reminder, for either recipient", () => {
    // Teachers asked for the five-days-before class reminder to be removed
    // outright rather than defaulted off, on their side and their students'.
    // Reintroducing either template name would start the sends again.
    expect(TEMPLATE_NAMES).not.toContain("reminder_5d");
    expect(TEMPLATE_NAMES).not.toContain("reminder_5d_teacher");
  });

  it("names are stable — pinned against accidental rename", () => {
    // If this fails, someone renamed a template. templateName is a stable
    // contract (notifications.template_name persists it in the DB and the
    // dispatcher routes by exact match), so a rename here needs a deliberate
    // migration, not an incidental edit.
    expect([...TEMPLATE_NAMES].sort()).toEqual(
      [
        "booking_confirmation",
        "cancel_gte24h_with_reschedule",
        "cancel_lt24h",
        "dispute_lost_student",
        "dispute_lost_teacher",
        "magic_link",
        "materials_send",
        "payment_marked_sent_teacher",
        "payment_pending_teacher",
        "payment_received",
        "reminder_1h",
        "reminder_24h",
        "reschedule_confirm",
        "teacher_cancel",
        // Audit P1/P2 additions (2026-05-27):
        "account_disabled_teacher",
        "booking_created_teacher",
        "cancel_gte24h_teacher",
        "cancel_lt24h_teacher",
        "no_show_student",
        "payment_failed_student",
        "refund_issued_student",
        "refund_issued_teacher",
        "reschedule_confirm_teacher",
        "stripe_ready_teacher",
        "stripe_requirements_teacher",
        "student_acquisition_plan_teacher",
        // Pre-expiry nudge (2026-06-03):
        "package_expiry_nudge",
        // Wise confirm reminder (2026-06-04):
        "wise_confirm_reminder_teacher",
        // Stripe sale notice (2026-06-10):
        "payment_received_teacher",
        // Wise mark-sent student ack (2026-06-10):
        "wise_marked_sent_student",
        // Consumed-package renewal nudges (2026-06-10):
        "package_consumed_student",
        "package_consumed_teacher",
        // Subscription / monetization (2026-06-12, teacher email-only):
        "subscription_trial_ending",
        "subscription_payment_succeeded",
        "subscription_payment_failed",
        "subscription_canceled",
        "subscription_founding_price_locked",
        // Library material assigned (2026-06-16, student email-only):
        "library_material_assigned",
        // Lesson-insights review nudge (Phase F, teacher email-only):
        "lesson_insights_review_teacher",
        // Five-minute pre-class reminder (2026-06-28, student push/email):
        "reminder_15m",
        // Facebook-groups posting nudge (STUDENT_ACQUISITION.md, teacher email-only):
        "facebook_groups_nudge_teacher",
        // Chat message notifications (2026-06-29, student + teacher email/push):
        "chat_message",
        "chat_message_teacher",
        // Teacher pre-class reminders (2026-07-07, teacher push/email):
        "reminder_24h_teacher",
        "reminder_1h_teacher",
        "reminder_15m_teacher",
        // Homework submitted (2026-07-20, teacher push/email):
        "homework_submitted_teacher",
        // Homework assigned (docs/features/homework.md, student push/email):
        "homework_assigned_student",
        // Homework feedback available (slice 4, student push/email):
        "homework_feedback_available_student",
        // Homework due-soon/overdue reminders (slice 6, student push/email):
        "homework_due_soon_student",
        "homework_overdue_student",
      ].sort(),
    );
  });

  it("library_material_assigned: materials-page button", () => {
    const vars = {
      teacherName: "Alicia Moreno",
      materialLabel: "Unidad 3 — lectura",
      materialsPathSuffix: "mis-clases/materials",
    };
    expect(urlButtonSuffix("library_material_assigned", vars)).toBe("mis-clases/materials");
  });

  it("package_consumed_student: portal repurchase button", () => {
    const vars = {
      teacherName: "Alicia Moreno",
      packageName: "10 clases",
      renewPathSuffix: "mis-clases/buy",
    };
    expect(urlButtonSuffix("package_consumed_student", vars)).toBe("mis-clases/buy");
  });

  it("package_expiry_nudge: booking-link button", () => {
    const vars = {
      teacherName: "Alicia Moreno",
      packageName: "10 clases",
      classesRemaining: "3",
      expiryDate: "10 jun 2026",
      bookingLinkPathSuffix: "b/alicia-moreno",
    };
    expect(urlButtonSuffix("package_expiry_nudge", vars)).toBe("b/alicia-moreno");
  });
});
