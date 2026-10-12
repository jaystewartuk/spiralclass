import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// Inline per-field validation (canonical form pattern) on the teacher's
// roster contact-edit and add-student forms: the required `name` field is
// validated on submit via the shared Zod schema, but the submit button stays
// enabled (only `disabled` while pending) and the name input renders normally.
// These SSR checks pin that the button isn't gated on a validity flag and the
// name field is present — the anti-regression for "silently disabled button
// with no explanation".

// The forms pull server actions (which reach prisma/server-only) and the
// locale provider — stub both so the client components render in isolation.
vi.mock("@/app/actions/student-contact", () => ({
  updateStudentContactAsTeacherAction: vi.fn(),
}));
vi.mock("@/app/actions/teacher-students", () => ({
  createStudentAction: vi.fn(),
}));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { ContactEditForm } =
  await import("@/app/(app)/dashboard/students/[studentId]/contact-edit-form");
const { AddStudentForm } = await import("@/app/(app)/dashboard/students/new/add-student-form");

describe("ContactEditForm — inline name validation", () => {
  const html = renderToStaticMarkup(
    React.createElement(ContactEditForm, {
      studentId: "s1",
      initialName: "Mira",
      initialEmail: "mira@example.com",
      initialPhone: null,
      emailLocked: false,
      defaultPhoneCountry: "MX",
      initialTimezone: null,
      timezoneOptions: [],
    }),
  );

  it("renders the required name field", () => {
    expect(html).toContain('name="name"');
    expect(html).toContain('id="student-contact-name"');
  });

  it("keeps the submit button enabled (not gated on a validity flag)", () => {
    expect(html).toContain("<button");
    // Checks the serialized boolean attribute specifically — a plain
    // substring check on "disabled" false-positives on Tailwind's
    // `disabled:cursor-not-allowed` variant classes, always present in the
    // className regardless of the actual disabled state.
    expect(html).not.toContain('disabled=""');
  });
});

describe("ContactEditForm — phone field re-population", () => {
  // Regression: re-populating the phone field from a saved E.164 value used
  // to dump the whole "+521234567890" string into the bare national-number
  // input, duplicating the country code already shown by the dropdown chip.
  it("shows only the local number, not the full E.164, for a saved +52 phone", () => {
    const html = renderToStaticMarkup(
      React.createElement(ContactEditForm, {
        studentId: "s1",
        initialName: "Mira",
        initialEmail: "mira@example.com",
        initialPhone: "+525512345678",
        emailLocked: false,
        defaultPhoneCountry: "MX",
        initialTimezone: null,
        timezoneOptions: [],
      }),
    );
    expect(html).toContain('value="5512345678"');
    expect(html).not.toContain('value="+525512345678"');
    expect(html).not.toContain('value="525512345678"');
  });

  it("splits by the number's own calling code even when it differs from the teacher's default", () => {
    const html = renderToStaticMarkup(
      React.createElement(ContactEditForm, {
        studentId: "s1",
        initialName: "Mira",
        initialEmail: "mira@example.com",
        initialPhone: "+447911123456",
        emailLocked: false,
        defaultPhoneCountry: "MX",
        initialTimezone: null,
        timezoneOptions: [],
      }),
    );
    expect(html).toContain('value="7911123456"');
  });
});

describe("ContactEditForm — the student's time zone", () => {
  // A teacher whose student moved had no zone field to change. The saved zone
  // must show as selected even when the quick-pick list lacks it (Vienna is
  // not on it), or the form would read as "not set" and post nothing.
  const render = (initialTimezone: string | null) =>
    renderToStaticMarkup(
      React.createElement(ContactEditForm, {
        studentId: "s1",
        initialName: "Catarina",
        initialEmail: null,
        initialPhone: null,
        emailLocked: true,
        defaultPhoneCountry: "MX",
        initialTimezone,
        timezoneOptions: ["America/Toronto", "America/Mexico_City"],
      }),
    );

  it("posts the saved zone, even one missing from the quick-pick list", () => {
    const html = render("Europe/Vienna");
    expect(html).toContain('id="student-contact-timezone"');
    expect(html).toMatch(/<input type="hidden" name="timezone" value="Europe\/Vienna"\/>/);
  });

  it("says plainly that booked classes do not move", () => {
    expect(render(null)).toContain("web.dashboard.students.contact.timezoneHint");
  });

  it("posts nothing for a student with no zone, so saving other fields leaves it unset", () => {
    expect(render(null)).toMatch(/<input type="hidden" name="timezone" value=""\/>/);
  });
});

describe("AddStudentForm — inline name validation", () => {
  const html = renderToStaticMarkup(
    React.createElement(AddStudentForm, { defaultPhoneCountry: "MX" }),
  );

  it("renders the required name field", () => {
    expect(html).toContain('name="name"');
    expect(html).toContain('id="new-student-name"');
  });

  it("keeps the submit button enabled (not gated on a validity flag)", () => {
    expect(html).toContain("<button");
    // Checks the serialized boolean attribute specifically — a plain
    // substring check on "disabled" false-positives on Tailwind's
    // `disabled:cursor-not-allowed` variant classes, always present in the
    // className regardless of the actual disabled state.
    expect(html).not.toContain('disabled=""');
  });
});
