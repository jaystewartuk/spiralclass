import { describe, expect, it } from "vitest";
import { createT } from "@spiralclass/shared";

import { overrideActionLabel } from "./labels";

// `Override.action` is a bare string column written by
// `app/actions/overrides.ts`, and two screens render it. The point of this
// module is that both get the same words, so what is worth locking is that
// every action the app can WRITE has a name here, and that an action it can
// no longer write still renders — the log is history.
describe("overrideActionLabel", () => {
  const t = createT("es-MX");

  it("names every action, in words rather than the column value", () => {
    for (const action of [
      "teacher_book_class",
      "teacher_cancel",
      "mark_complete",
      "mark_no_show",
      "restore_class",
      "waive_cancellation",
      "extend_expiration",
      "set_custom_price",
      "archive_student",
      "reactivate_student",
      "set_class_language",
    ]) {
      const label = overrideActionLabel(action, t);
      expect(label).not.toBe(action);
      expect(label).not.toMatch(/^web\./); // a missing catalog key, not a name
      expect(label.trim()).not.toBe("");
    }
  });

  it("names the two student-scoped actions, which is why this module exists", () => {
    // The teacher's "Account adjustments" card printed these raw before the
    // table moved out of the class-detail page.
    expect(overrideActionLabel("archive_student", t)).not.toContain("_");
    expect(overrideActionLabel("reactivate_student", t)).not.toContain("_");
  });

  it("falls back to the raw action rather than throwing on a retired one", () => {
    // Rows outlive the code that wrote them; a retired action must still
    // render its row instead of taking the log down.
    expect(overrideActionLabel("some_retired_action", t)).toBe("some_retired_action");
    expect(overrideActionLabel("", t)).toBe("");
  });

  it("answers in the caller's language, not a baked-in one", () => {
    const es = overrideActionLabel("mark_complete", createT("es-MX"));
    const en = overrideActionLabel("mark_complete", createT("en"));
    expect(es).not.toBe(en);
  });
});
