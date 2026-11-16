import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NotificationGapNotice,
  StudentNotificationsOffNotice,
} from "@/components/notification-gap-notice";
import { createT } from "@/lib/i18n-translate";
import {
  allDisabledPrefs,
  defaultNewStudentNotificationPrefs,
} from "@/lib/notifications/preferences";

function render(prefs: object | null, locale: "en" | "es" | "fr" = "en") {
  return renderToStaticMarkup(
    <NotificationGapNotice
      studentId="s1"
      studentName="Sam"
      prefs={prefs}
      category="class_materials"
      t={createT(locale)}
    />,
  );
}

describe("NotificationGapNotice", () => {
  it("renders nothing when the student will be told", () => {
    expect(render(null)).toBe("");
    expect(render(defaultNewStudentNotificationPrefs())).toBe("");
  });

  it("names the student and the category when it is stored off", () => {
    const html = render({ ...defaultNewStudentNotificationPrefs(), class_materials: false });
    expect(html).toContain('data-notification-gap="category_off"');
    expect(html).toContain("Sam");
    expect(html).toContain("class materials and homework");
    expect(html).not.toContain("<a ");
  });

  it("links an imported, paused student to the Settings tab", () => {
    const html = render(allDisabledPrefs());
    expect(html).toContain('data-notification-gap="paused"');
    expect(html).toContain("/dashboard/students/s1?tab=settings");
  });

  // The teacher booking screen asks about booking updates: a booking
  // confirmation is what a student with them off never receives (#77).
  it("names booking updates on the booking screen when that category is off", () => {
    const html = renderToStaticMarkup(
      <NotificationGapNotice
        studentId="s1"
        studentName="Sam"
        prefs={{ ...defaultNewStudentNotificationPrefs(), booking_updates: false }}
        category="booking_updates"
        t={createT("en")}
      />,
    );
    expect(html).toContain('data-notification-gap="category_off"');
    expect(html).toContain("booking updates");
  });

  it("has copy in every locale", () => {
    const off = { ...defaultNewStudentNotificationPrefs(), class_materials: false };
    for (const locale of ["es", "fr"] as const) {
      expect(render(off, locale)).toContain("Sam");
      expect(render(off, locale)).not.toContain("web.notificationGap");
    }
  });
});

// #77: a student made live with every category stored off was told nothing,
// and nothing on her page said so once the Go live card had gone.
describe("StudentNotificationsOffNotice", () => {
  function renderStudent(
    prefs: object | null,
    opts: { onHold?: boolean; archived?: boolean; locale?: "en" | "es" | "fr" } = {},
  ) {
    return renderToStaticMarkup(
      <StudentNotificationsOffNotice
        studentId="s1"
        studentName="Sam"
        prefs={prefs}
        onHold={opts.onHold ?? false}
        archived={opts.archived ?? false}
        t={createT(opts.locale ?? "en")}
      />,
    );
  }

  it("says a live student with every notification off will get no confirmations, and links to the switch", () => {
    const html = renderStudent(allDisabledPrefs());
    expect(html).toContain('data-notification-gap="student_off"');
    expect(html).toContain("Sam");
    expect(html).toContain("booking confirmations");
    expect(html).toContain("/dashboard/students/s1?tab=settings");
  });

  it("renders nothing for a student who will be told", () => {
    expect(renderStudent(null)).toBe("");
    expect(renderStudent(defaultNewStudentNotificationPrefs())).toBe("");
    // One category off is the student's choice, not "receives nothing".
    expect(renderStudent({ ...defaultNewStudentNotificationPrefs(), messages: false })).toBe("");
  });

  it("stays out of the way while the Go live card or the archive already says nothing is sent", () => {
    expect(renderStudent(allDisabledPrefs(), { onHold: true })).toBe("");
    expect(renderStudent(allDisabledPrefs(), { archived: true })).toBe("");
  });

  it("has copy in every locale", () => {
    for (const locale of ["es", "fr"] as const) {
      const html = renderStudent(allDisabledPrefs(), { locale });
      expect(html).toContain("Sam");
      expect(html).not.toContain("web.notificationGap");
    }
  });
});
