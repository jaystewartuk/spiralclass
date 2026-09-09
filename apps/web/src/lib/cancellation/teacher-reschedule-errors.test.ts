import { describe, expect, it } from "vitest";
import { createT } from "@spiralclass/shared";

import { TEACHER_RESCHEDULE_ERRORS, teacherRescheduleErrorKey } from "./teacher-reschedule-errors";

// The point of this module is that the action returns a code and the reader's
// own locale words it. What is worth locking is that every code the action can
// actually return resolves to real copy in every locale — and that an
// unrecognised one still resolves to a sentence, because this runs inside
// render on a value that crossed a server-action boundary.
describe("teacherRescheduleErrorKey", () => {
  for (const locale of ["es-MX", "en", "fr"] as const) {
    it(`words every failure code in ${locale}`, () => {
      const t = createT(locale);
      const seen = new Set<string>();
      for (const code of TEACHER_RESCHEDULE_ERRORS) {
        const sentence = t(teacherRescheduleErrorKey(code));
        // A missing catalog entry renders as the key itself.
        expect(sentence).not.toMatch(/^teacherReschedule\./);
        expect(sentence.trim()).not.toBe("");
        seen.add(sentence);
      }
      // Distinct codes exist to say distinct things; two that render the same
      // sentence are a code the teacher cannot act on.
      expect(seen.size).toBe(TEACHER_RESCHEDULE_ERRORS.length);
    });
  }

  it("falls back to a sentence for a code it does not know", () => {
    const t = createT("es-MX");
    expect(t(teacherRescheduleErrorKey("something-newer"))).toBe(
      t("teacherReschedule.error.slot-unavailable"),
    );
  });
});
