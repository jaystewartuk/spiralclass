import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationGapNotice } from "@/components/notification-gap-notice";
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

  it("has copy in every locale", () => {
    const off = { ...defaultNewStudentNotificationPrefs(), class_materials: false };
    for (const locale of ["es", "fr"] as const) {
      expect(render(off, locale)).toContain("Sam");
      expect(render(off, locale)).not.toContain("web.notificationGap");
    }
  });
});
