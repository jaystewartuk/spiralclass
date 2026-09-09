import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// Canonical inline per-field validation was added to the account forms
// (my-details name, email-change new-email). SSR can't fire the onSubmit
// handler, but it can pin that the component still renders with the new
// validation wiring (a broken import/hook would throw here), the submit button
// stays enabled (it renders, no disabled attr on it), and the validated field
// keeps its `name`. The messages come from the shared Zod schemas
// (teacherContactSchema / signInSchema), so nothing new is hardcoded.

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { MyDetailsForm } = await import("@/components/account/my-details-form");
const { EmailChangeForm } = await import("@/components/account/email-change-form");

const noopAction = async () => undefined;

// Assert the button carrying `label` is present and rendered enabled (no
// `disabled` attribute on that specific <button>). Robust against other
// disabled elements elsewhere in the form (e.g. a read-only email input).
function buttonEnabled(html: string, label: string): boolean {
  // Find the <button> whose content includes the label (tolerating nested
  // markup like an icon/span), then assert its markup carries no `disabled`.
  for (const match of html.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
    // React SSR renders the boolean prop as the attribute `disabled=""`. Match
    // that exact form, not a bare "disabled" substring — the shadcn Button
    // className carries Tailwind `disabled:opacity-50` utilities that would
    // otherwise false-positive.
    if (match[0].includes(label)) return !match[0].includes('disabled=""');
  }
  return false;
}

describe("MyDetailsForm — inline validation", () => {
  it("renders the name field and keeps the save button enabled", () => {
    const html = renderToStaticMarkup(
      React.createElement(MyDetailsForm, {
        action: noopAction,
        initialName: "",
        initialPhone: null,
        initialTimezone: null,
        timezoneOptions: ["America/Mexico_City"],
      }),
    );
    expect(html).toContain('name="name"');
    expect(buttonEnabled(html, "common.save")).toBe(true);
  });
});

describe("MyDetailsForm — phone field re-population", () => {
  // Regression: re-populating the phone field from a saved E.164 value used
  // to dump the whole "+521234567890" string into the bare national-number
  // input, duplicating the country code already shown by the dropdown chip.
  it("shows only the local number, not the full E.164, for a saved MX phone", () => {
    const html = renderToStaticMarkup(
      React.createElement(MyDetailsForm, {
        action: noopAction,
        initialName: "Mira",
        initialPhone: "+525512345678",
        initialTimezone: null,
        timezoneOptions: ["America/Mexico_City"],
        initialPhoneCountry: "MX",
      }),
    );
    expect(html).toContain('value="5512345678"');
    expect(html).not.toContain('value="+525512345678"');
    expect(html).not.toContain('value="525512345678"');
  });

  it("splits by the number's own calling code even when it differs from the seeded hint", () => {
    const html = renderToStaticMarkup(
      React.createElement(MyDetailsForm, {
        action: noopAction,
        initialName: "Mira",
        initialPhone: "+447911123456",
        initialTimezone: null,
        timezoneOptions: ["America/Mexico_City"],
        initialPhoneCountry: "MX",
      }),
    );
    expect(html).toContain('value="7911123456"');
  });

  it("splits with no country hint at all (the student caller)", () => {
    const html = renderToStaticMarkup(
      React.createElement(MyDetailsForm, {
        action: noopAction,
        initialName: "Mira",
        initialPhone: "+525512345678",
        initialTimezone: null,
        timezoneOptions: ["America/Mexico_City"],
      }),
    );
    expect(html).toContain('value="5512345678"');
  });
});

describe("EmailChangeForm — inline validation", () => {
  it("renders the new-email field and keeps the send button enabled", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmailChangeForm, {
        action: noopAction,
        verifyAction: noopAction,
        currentEmail: "old@example.com",
        justChanged: false,
      }),
    );
    expect(html).toContain('name="newEmail"');
    expect(buttonEnabled(html, "web.emailChangeForm.sendCode")).toBe(true);
  });

  // Google-linked accounts get the disconnect warning + a required
  // acknowledgement before the send button is usable — the UI-warning half
  // of the Google-OAuth-email-change fix (lib/auth/identity-change.ts covers
  // the actual server-side disconnect).
  it("warns and disables the send button (unacknowledged) when Google is linked", () => {
    const html = renderToStaticMarkup(
      React.createElement(EmailChangeForm, {
        action: noopAction,
        verifyAction: noopAction,
        currentEmail: "old@example.com",
        justChanged: false,
        hasGoogleLinked: true,
      }),
    );
    expect(html).toContain("web.emailChangeForm.googleWarning");
    expect(html).toContain("web.emailChangeForm.googleConfirmLabel");
    expect(buttonEnabled(html, "web.emailChangeForm.sendCode")).toBe(false);
  });
});
