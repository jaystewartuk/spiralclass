import { describe, expect, it } from "vitest";
import { TEMPLATE_NAMES, isTeacherRecipientTemplate } from "@/lib/notifications/templates";
import {
  NOTIFICATION_CATEGORIES,
  TEACHER_NOTIFICATION_CATEGORIES,
  allDisabledPrefs,
  coerceNotificationPrefs,
  coerceTeacherNotificationPrefs,
  defaultNewStudentNotificationPrefs,
  getAllowedChannels,
  isBillingCriticalTemplate,
  isCategoryEnabled,
  isNotificationsFullyDisabled,
  isStudentMoneyOfRecordTemplate,
  isTransactionalTemplate,
  teacherTemplateCategory,
  templateCategory,
} from "@/lib/notifications/preferences";

describe("isCategoryEnabled", () => {
  it("defaults to enabled when prefs are null/undefined (funnel students)", () => {
    expect(isCategoryEnabled(null, "class_reminders")).toBe(true);
    expect(isCategoryEnabled(undefined, "expiry_reminders")).toBe(true);
  });
  it("enabled when the category key is absent", () => {
    expect(isCategoryEnabled({ expiry_reminders: false }, "class_reminders")).toBe(true);
  });
  it("disabled only when explicitly false", () => {
    expect(isCategoryEnabled({ class_reminders: false }, "class_reminders")).toBe(false);
    expect(isCategoryEnabled({ class_reminders: true }, "class_reminders")).toBe(true);
  });
});

describe("allDisabledPrefs", () => {
  it("turns every category off (used to silence imported students)", () => {
    const prefs = allDisabledPrefs();
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(prefs[c]).toBe(false);
      expect(isCategoryEnabled(prefs, c)).toBe(false);
    }
  });
});

describe("defaultNewStudentNotificationPrefs", () => {
  it("keeps only the class-critical + messaging categories on by default", () => {
    const prefs = defaultNewStudentNotificationPrefs();
    // Every category has an explicit value — no relying on "absent = on".
    for (const c of NOTIFICATION_CATEGORIES) expect(prefs).toHaveProperty(c);
    expect(isCategoryEnabled(prefs, "class_reminders")).toBe(true);
    expect(isCategoryEnabled(prefs, "booking_updates")).toBe(true);
    expect(isCategoryEnabled(prefs, "messages")).toBe(true);
    expect(isCategoryEnabled(prefs, "class_materials")).toBe(false);
    expect(isCategoryEnabled(prefs, "expiry_reminders")).toBe(false);
  });

  it("is distinct from the CSV-import all-off shape", () => {
    expect(isNotificationsFullyDisabled(defaultNewStudentNotificationPrefs())).toBe(false);
  });
});

describe("isNotificationsFullyDisabled", () => {
  it("is true for the exact CSV-import all-off shape", () => {
    expect(isNotificationsFullyDisabled(allDisabledPrefs())).toBe(true);
  });
  it("is false for null/undefined (never-imported or self-service default)", () => {
    expect(isNotificationsFullyDisabled(null)).toBe(false);
    expect(isNotificationsFullyDisabled(undefined)).toBe(false);
  });
  it("is false once any single category has been turned back on", () => {
    const prefs = { ...allDisabledPrefs(), booking_updates: true };
    expect(isNotificationsFullyDisabled(prefs)).toBe(false);
  });
  it("is false when every category is explicitly true", () => {
    const prefs = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, true]));
    expect(isNotificationsFullyDisabled(prefs)).toBe(false);
  });
});

describe("coerceNotificationPrefs", () => {
  it("keeps known booleans and drops unknown / non-boolean keys", () => {
    expect(
      coerceNotificationPrefs({
        class_reminders: true,
        expiry_reminders: false,
        bogus: true,
        booking_updates: "yes",
      }),
    ).toEqual({ class_reminders: true, expiry_reminders: false });
  });
  it("returns {} for non-objects", () => {
    expect(coerceNotificationPrefs(null)).toEqual({});
    expect(coerceNotificationPrefs("nope")).toEqual({});
  });
  it("preserves channelPrefs for known categories and channels", () => {
    const result = coerceNotificationPrefs({
      class_reminders: false,
      channelPrefs: { class_reminders: ["push", "email"], booking_updates: ["email"] },
    });
    expect(result).toEqual({
      class_reminders: false,
      channelPrefs: { class_reminders: ["push", "email"], booking_updates: ["email"] },
    });
  });
  it("drops unknown categories from channelPrefs", () => {
    const result = coerceNotificationPrefs({
      channelPrefs: { class_reminders: ["push"], unknown_cat: ["email"] },
    });
    expect(result.channelPrefs).toEqual({ class_reminders: ["push"] });
  });
  it("drops unknown channel strings from channelPrefs", () => {
    const result = coerceNotificationPrefs({
      channelPrefs: { class_reminders: ["push", "fax", "email"] },
    });
    expect(result.channelPrefs).toEqual({ class_reminders: ["push", "email"] });
  });
  it("omits channelPrefs from output when absent from input", () => {
    const result = coerceNotificationPrefs({ class_reminders: false });
    expect(result.channelPrefs).toBeUndefined();
  });
});

describe("getAllowedChannels", () => {
  it("returns null for null/undefined prefs (no restriction)", () => {
    expect(getAllowedChannels(null, "class_reminders")).toBeNull();
    expect(getAllowedChannels(undefined, "class_reminders")).toBeNull();
  });
  it("returns null when channelPrefs is absent or empty for the category", () => {
    expect(getAllowedChannels({}, "class_reminders")).toBeNull();
    expect(getAllowedChannels({ channelPrefs: {} }, "class_reminders")).toBeNull();
    expect(
      getAllowedChannels({ channelPrefs: { class_reminders: [] } }, "class_reminders"),
    ).toBeNull();
  });
  it("returns the stored channel list for the category", () => {
    expect(
      getAllowedChannels(
        { channelPrefs: { class_reminders: ["push", "email"] } },
        "class_reminders",
      ),
    ).toEqual(["push", "email"]);
  });
  it("filters out unknown channel strings from the stored list", () => {
    expect(
      getAllowedChannels({ channelPrefs: { class_reminders: ["push", "fax"] } }, "class_reminders"),
    ).toEqual(["push"]);
  });
  it("returns null when all stored channels are unknown (full cascade restored)", () => {
    expect(
      getAllowedChannels({ channelPrefs: { class_reminders: ["fax"] } }, "class_reminders"),
    ).toBeNull();
  });
});

describe("template categorization", () => {
  it("magic_link is transactional (never gated)", () => {
    expect(isTransactionalTemplate("magic_link")).toBe(true);
    expect(templateCategory("magic_link")).toBeNull();
  });

  it("every student lifecycle template maps to a category", () => {
    // Guards the `default: return null` in templateCategory: a new
    // student-recipient lifecycle template that isn't categorized would
    // silently bypass the preference gate (always sent). Teacher-recipient,
    // transactional, and money-of-record templates are intentionally
    // uncategorized (never suppressible).
    for (const t of TEMPLATE_NAMES) {
      if (
        isTeacherRecipientTemplate(t) ||
        isTransactionalTemplate(t) ||
        isStudentMoneyOfRecordTemplate(t)
      ) {
        expect(templateCategory(t)).toBeNull();
      } else {
        expect(
          templateCategory(t),
          `student template '${t}' must have a notification category`,
        ).not.toBeNull();
      }
    }
  });

  it("student money-of-record templates (receipts, failed payments, deductions) are never suppressible", () => {
    for (const t of [
      "payment_received",
      "payment_failed_student",
      "refund_issued_student",
      "wise_marked_sent_student",
      "cancel_lt24h",
      "no_show_student",
    ] as const) {
      expect(isStudentMoneyOfRecordTemplate(t)).toBe(true);
      expect(templateCategory(t)).toBeNull();
    }
  });
});

describe("teacher notification categories", () => {
  it("coerceTeacherNotificationPrefs keeps known teacher keys and drops the rest", () => {
    expect(
      coerceTeacherNotificationPrefs({
        class_activity: false,
        student_progress: true,
        // A STUDENT-only category must never leak into the teacher prefs map.
        // (class_reminders is now shared with teachers, so use booking_updates.)
        booking_updates: false,
        bogus: true,
      }),
    ).toEqual({ class_activity: false, student_progress: true });
  });

  it("coerceTeacherNotificationPrefs preserves channelPrefs (push | email only)", () => {
    const result = coerceTeacherNotificationPrefs({
      class_activity: false,
      channelPrefs: {
        class_activity: ["push"],
        student_progress: ["email"],
        unknown_cat: ["push"],
      },
    });
    expect(result).toEqual({
      class_activity: false,
      channelPrefs: { class_activity: ["push"], student_progress: ["email"] },
    });
  });

  it("coerceTeacherNotificationPrefs drops whatsapp from teacher channelPrefs (not a valid channel)", () => {
    const result = coerceTeacherNotificationPrefs({
      channelPrefs: { class_activity: ["push", "whatsapp", "email"] },
    });
    // whatsapp is no longer in TEACHER_NOTIFICATION_CHANNELS — filtered out.
    expect(result.channelPrefs).toEqual({ class_activity: ["push", "email"] });
  });

  it("maps suppressible teacher templates to a teacher category, others to null", () => {
    expect(teacherTemplateCategory("reminder_24h_teacher")).toBe("class_reminders");
    expect(teacherTemplateCategory("reminder_1h_teacher")).toBe("class_reminders");
    expect(teacherTemplateCategory("reminder_15m_teacher")).toBe("class_reminders");
    expect(teacherTemplateCategory("booking_created_teacher")).toBe("class_activity");
    expect(teacherTemplateCategory("cancel_lt24h_teacher")).toBe("class_activity");
    expect(teacherTemplateCategory("reschedule_confirm_teacher")).toBe("class_activity");
    expect(teacherTemplateCategory("lesson_insights_review_teacher")).toBe("student_progress");
    expect(teacherTemplateCategory("package_consumed_teacher")).toBe("student_progress");
    expect(teacherTemplateCategory("subscription_trial_ending")).toBe("subscription");
    expect(teacherTemplateCategory("facebook_groups_nudge_teacher")).toBe("growth");
    expect(teacherTemplateCategory("chat_message_teacher")).toBe("messages");

    // Money-of-record / security / billing-critical → never gateable.
    expect(teacherTemplateCategory("payment_received_teacher")).toBeNull();
    expect(teacherTemplateCategory("payment_pending_teacher")).toBeNull();
    expect(teacherTemplateCategory("refund_issued_teacher")).toBeNull();
    expect(teacherTemplateCategory("stripe_requirements_teacher")).toBeNull();
    expect(teacherTemplateCategory("account_disabled_teacher")).toBeNull();
    expect(teacherTemplateCategory("subscription_payment_failed")).toBeNull();
  });

  it("billing-critical subscription notices are non-suppressible", () => {
    expect(isBillingCriticalTemplate("subscription_payment_failed")).toBe(true);
    expect(isBillingCriticalTemplate("subscription_canceled")).toBe(true);
    expect(isBillingCriticalTemplate("subscription_trial_ending")).toBe(false);
  });

  it("every teacher category returned by teacherTemplateCategory is a known toggle", () => {
    // A category the dispatcher could gate on but the form never renders would
    // be unmutable-by-UI — keep the producer and the toggle list in lockstep.
    const known = new Set<string>(TEACHER_NOTIFICATION_CATEGORIES);
    for (const t of TEMPLATE_NAMES) {
      const cat = teacherTemplateCategory(t);
      if (cat) expect(known.has(cat), `'${cat}' must be a teacher toggle`).toBe(true);
    }
  });
});
