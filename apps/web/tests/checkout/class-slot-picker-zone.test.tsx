// @vitest-environment jsdom
//
// Slot times used to render in the TEACHER's timezone, always, labelled "Times
// shown in your teacher's zone (America/Mexico_City)". That asks a buyer
// abroad to do timezone arithmetic in the middle of a checkout — and for a
// package the step is optional, so the cheapest way out of the arithmetic is
// to abandon it.
//
// The slot is an instant (`startUtc`) either way, so this is presentation
// only. What has to hold is that the SERVER pass still renders the teacher's
// zone — resolving the visitor's during render would make the first client
// render disagree with the HTML and fail hydration.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}(${JSON.stringify(vars)})` : key,
  useLocale: () => "en",
}));

const { ClassSlotPicker } = await import("@/app/b/[slug]/buy/class-slot-picker");

describe("ClassSlotPicker — whose clock the times are on", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(timezone: string) {
    act(() => {
      root.render(
        React.createElement(ClassSlotPicker, {
          timezone,
          bufferMin: 0,
          minAdvanceH: 2,
          maxAdvanceDays: 30,
          classDurationMin: 50,
          inputs: { availabilityRules: [], blockedDates: [], existingBookings: [] },
          value: null,
          onChange: vi.fn(),
          optional: true,
        } as never),
      );
    });
  }

  it("labels the times with the visitor's own zone once the browser has one", () => {
    // A teacher on the other side of the world from whoever is running this,
    // so the two zones are guaranteed to differ — the case this exists for.
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const elsewhere = here === "Asia/Tokyo" ? "America/Mexico_City" : "Asia/Tokyo";
    render(elsewhere);
    expect(container.textContent).toContain("web.buyFlow.timesInYourZone");
    // and it still says where SHE is, so a buyer can reason about her day
    expect(container.textContent).toContain(elsewhere);
    expect(container.textContent).toContain(here);
  });

  it("falls back to the teacher's zone when the visitor shares it", () => {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    render(here);
    expect(container.textContent).toContain("web.buyFlow.timesInTeacherZone");
    expect(container.textContent).not.toContain("web.buyFlow.timesInYourZone");
  });

  it("spells the chosen day out, so 01/09 is not two different days", () => {
    render("Asia/Tokyo");
    const dayNames = /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/;
    expect(container.textContent).toMatch(dayNames);
  });
});
