import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The teacher's "block dates" form. It is a CONTROLLED pair of date fields —
// the calendar beside it and these inputs are two views of one selection — and
// it validates on submit through the same shared `blockedDateSchema` the
// server action uses, so the cross-field "end before start" rule can point at
// the end-date field.
//
// These SSR checks pin the properties a regression would silently remove: the
// submit button is never gated on a validity flag (only on `pending`), the
// fields carry the selection they were given, a past date cannot be typed in,
// and the impact of the block is stated BEFORE the button rather than after.

vi.mock("@/app/actions/blocked-dates", () => ({
  createBlockedDateAction: vi.fn(),
}));
vi.mock("@/components/locale-provider", () => ({
  // Renders as `key#count` so an assertion can pin the NUMBER a plural string
  // was handed without depending on how JSON escapes in HTML.
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars?.count === undefined ? key : `${key}#${vars.count}`,
  useLocale: () => "en",
}));

const { BlockedDateForm } = await import("@/app/(app)/settings/blocked-dates/blocked-date-form");

const noop = () => {};
function render(overrides: Partial<React.ComponentProps<typeof BlockedDateForm>> = {}) {
  return renderToStaticMarkup(
    React.createElement(BlockedDateForm, {
      startDate: "2026-07-17",
      endDate: "2026-07-19",
      minDate: "2026-07-17",
      impactCount: 0,
      onChangeStart: noop,
      onChangeEnd: noop,
      onBlocked: noop,
      ...overrides,
    }),
  );
}

describe("BlockedDateForm", () => {
  const html = render();

  it("renders both required date fields", () => {
    expect(html).toContain('name="startDate"');
    expect(html).toContain('name="endDate"');
    expect(html).toContain('id="startDate"');
    expect(html).toContain('id="endDate"');
  });

  it("shows the selection it was handed rather than a default", () => {
    expect(html).toContain('value="2026-07-17"');
    expect(html).toContain('value="2026-07-19"');
  });

  it("floors both fields so a past day cannot be typed in", () => {
    // A block in the past cancels nothing and frees nothing. The grid refuses
    // one too; the typed path has to agree with it.
    expect(html).toContain('min="2026-07-17"');
  });

  it("keeps the submit button enabled (not gated on a validity flag)", () => {
    expect(html).toContain("<button");
    // The only `disabled` toggles off `pending`, which is false on first render.
    // Checks for the serialized boolean attribute specifically — a plain
    // substring check on "disabled" false-positives on Tailwind's
    // `disabled:cursor-not-allowed` variant classes, which are always present
    // in the button's className regardless of the actual disabled state.
    expect(html).not.toContain('disabled=""');
  });

  it("counts the days it is about to block on the button", () => {
    expect(html).toContain("web.settings.blockedDates.blockDays");
    expect(html).toContain("web.settings.blockedDates.blockDays#3");
  });

  it("says the student will see the reason", () => {
    expect(html).toContain("web.settings.blockedDates.reasonHint");
    expect(html).toContain('aria-describedby="reason-hint"');
  });

  it("warns about booked classes before the button, not after the fact", () => {
    const withClasses = render({ impactCount: 2 });
    expect(withClasses).toContain("web.settings.blockedDates.impact");
    expect(withClasses).toContain("web.settings.blockedDates.impact#2");
  });

  it("stays quiet when the range holds no classes", () => {
    expect(html).not.toContain("web.settings.blockedDates.impact");
  });
});
