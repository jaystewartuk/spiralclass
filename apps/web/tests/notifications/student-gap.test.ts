import { describe, expect, it } from "vitest";
import {
  allDisabledPrefs,
  defaultNewStudentNotificationPrefs,
} from "@/lib/notifications/preferences";
import { studentNotificationGap } from "@/lib/notifications/student-gap";

describe("studentNotificationGap", () => {
  it("is ok for a student who never touched her settings", () => {
    expect(studentNotificationGap(null, "class_materials")).toBe("ok");
    expect(studentNotificationGap(undefined, "class_materials")).toBe("ok");
  });

  it("is ok for a brand-new student under the D-204 defaults", () => {
    const prefs = defaultNewStudentNotificationPrefs();
    expect(studentNotificationGap(prefs, "class_materials")).toBe("ok");
    expect(studentNotificationGap(prefs, "class_reminders")).toBe("ok");
  });

  it("names the category when she (or an old default) stored it off", () => {
    const prefs = { ...defaultNewStudentNotificationPrefs(), class_materials: false };
    expect(studentNotificationGap(prefs, "class_materials")).toBe("category_off");
    expect(studentNotificationGap(prefs, "class_reminders")).toBe("ok");
  });

  it("says paused, not category_off, for the roster-import snapshot", () => {
    expect(studentNotificationGap(allDisabledPrefs(), "class_materials")).toBe("paused");
  });

  it("is ok once an imported student is launched (prefs cleared)", () => {
    expect(studentNotificationGap(null, "class_materials")).toBe("ok");
  });
});
