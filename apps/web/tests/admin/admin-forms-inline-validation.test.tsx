import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// Inline per-field validation (canonical form pattern) on the admin staff
// invite form and the admin student email-change form: the required email
// field is validated on submit via the shared `signInSchema` (guard-safe,
// localized message source), but the submit button stays enabled (only
// `disabled` while pending) and the email input renders normally. These SSR
// checks pin that the button isn't gated on a validity flag and the email
// field is present — the anti-regression for "silently disabled button with
// no explanation".

// The forms pull server actions (which reach prisma/server-only), sonner, and
// the locale provider — stub them so the client components render in isolation.
vi.mock("@/app/actions/admin-staff", () => ({
  inviteAdminAction: vi.fn(),
  toggleAdminDisabledAction: vi.fn(),
  updateAdminRoleAction: vi.fn(),
}));
vi.mock("@/app/actions/admin-students", () => ({
  adminChangeStudentEmailAction: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { InviteForm } = await import("@/app/admin/staff/invite-form");
const { StudentEmailForm } = await import("@/app/admin/students/[id]/email-form");

describe("InviteForm — inline email validation", () => {
  const html = renderToStaticMarkup(React.createElement(InviteForm));

  it("renders the required email field", () => {
    expect(html).toContain('name="email"');
    expect(html).toContain('id="invite-email"');
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

describe("StudentEmailForm — inline email validation", () => {
  const html = renderToStaticMarkup(
    React.createElement(StudentEmailForm, {
      studentId: "s1",
      currentEmail: "mira@example.com",
      hasLogin: true,
    }),
  );

  it("renders the required new-email field", () => {
    expect(html).toContain('name="newEmail"');
    expect(html).toContain('id="admin-new-email"');
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
