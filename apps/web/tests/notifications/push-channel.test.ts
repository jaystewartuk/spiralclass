import { describe, expect, it } from "vitest";
import { pushChannelForTemplate } from "@/lib/notifications/push";
import { TEMPLATE_NAMES } from "@/lib/notifications/templates";

// pushChannelForTemplate routes each template to an Android notification
// channel: "booking" carries a distinct chime (registered client-side) for
// calendar changes worth an instant glance; everything else rides the
// system-default "default" channel. Pinning the exact "booking" set here so
// a new template silently landing on the wrong channel (or the chime
// spreading to high-frequency/low-urgency sends and causing fatigue) shows
// up as a failing test.

const EXPECTED_BOOKING_CHANNEL_TEMPLATES = [
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
].sort();

describe("pushChannelForTemplate", () => {
  it("routes exactly the time-sensitive calendar templates to the booking channel", () => {
    const bookingTemplates = TEMPLATE_NAMES.filter(
      (t) => pushChannelForTemplate(t) === "booking",
    ).sort();
    expect(bookingTemplates).toEqual(EXPECTED_BOOKING_CHANNEL_TEMPLATES);
  });

  it("routes advance reminders and every other template to the default channel", () => {
    expect(pushChannelForTemplate("reminder_24h")).toBe("default");
    // Teacher advance reminders mirror the student ones: 24h is low-urgency.
    expect(pushChannelForTemplate("reminder_24h_teacher")).toBe("default");
    expect(pushChannelForTemplate("chat_message")).toBe("default");
    expect(pushChannelForTemplate("chat_message_teacher")).toBe("default");
    expect(pushChannelForTemplate("payment_received")).toBe("default");
    expect(pushChannelForTemplate("magic_link")).toBe("default");
  });
});
