import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The month grid the teacher picks a range on.
//
// It replaced a grid of `<div>`s carrying a `title` attribute, which was
// unreachable by keyboard, announced as a run of bare numbers, and labelled
// its columns from one of two hardcoded arrays chosen by `locale === "en"` —
// so a French teacher read Spanish weekdays. The checks here pin the grid
// semantics, the roving tab stop, the locale-derived headers and the
// non-colour signals, because every one of those is invisible in a screenshot
// and none of them has an E2E net.

const locale = { current: "en" };
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars?.count === undefined ? key : `${key}#${vars.count}`,
  useLocale: () => locale.current,
}));

const { BlockedDatesCalendar } =
  await import("@/app/(app)/settings/blocked-dates/blocked-dates-calendar");

const noop = () => {};

function render(overrides: Partial<React.ComponentProps<typeof BlockedDatesCalendar>> = {}) {
  return renderToStaticMarkup(
    React.createElement(BlockedDatesCalendar, {
      year: 2026,
      month0: 8, // September 2026
      todayYmd: "2026-09-15",
      blocks: [{ id: "b1", start: "2026-09-21", end: "2026-09-23", reason: "Holiday" }],
      classCounts: new Map([["2026-09-17", 2]]),
      selection: { start: "2026-09-15", end: "2026-09-16" },
      anchor: null,
      highlightedBlockId: null,
      onPickDay: noop,
      onMonthChange: noop,
      ...overrides,
    }),
  );
}

describe("BlockedDatesCalendar", () => {
  const html = render();

  it("is a real grid, not a stack of divs", () => {
    expect(html).toContain('role="grid"');
    expect(html.match(/role="gridcell"/g)).toHaveLength(42);
  });

  it("has exactly one tab stop for the whole month", () => {
    // Roving tabindex: 42 tab stops would make the calendar a wall to tab
    // past, and zero would make it unreachable.
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(41);
  });

  it("marks today", () => {
    expect(html).toContain('aria-current="date"');
    expect(html.match(/aria-current="date"/g)).toHaveLength(1);
  });

  it("names each day fully, not by its number alone", () => {
    // The column and month headings a sighted reader gets are not in the tab
    // order, so the cell has to carry the whole date itself.
    expect(html).toContain('aria-label="Tuesday, September 15, 2026');
  });

  it("marks a blocked day with a strike as well as a tint", () => {
    // Colour is never the only signal, and the strike is also what survives
    // the day being recoloured by a selection on top of it.
    expect(html).toContain("line-through");
    expect(html).toContain("web.settings.blockedDates.blocked");
  });

  it("refuses days in the past", () => {
    // aria-disabled rather than disabled: an APG grid keeps every cell
    // focusable so arrowing across the month does not skip holes.
    const past = html.match(/aria-disabled="true"/g) ?? [];
    // 1–14 September, plus the single August spill-over day (the 1st fell on
    // a Tuesday, and the grid starts its weeks on Monday).
    expect(past).toHaveLength(15);
  });

  it("selects the range it was given", () => {
    expect(html.match(/aria-selected="true"/g)).toHaveLength(2);
  });

  it("shows where classes are booked, and says how many", () => {
    expect(html).toContain("web.settings.blockedDates.dayClasses#2");
  });

  it("labels its columns from the locale, Monday first", () => {
    // The regression this pins: two hardcoded arrays picked by
    // `locale === "en"`, which handed every non-English, non-Spanish teacher
    // Spanish weekday abbreviations.
    expect(html).toContain("Monday");
    expect(html.indexOf("Monday")).toBeLessThan(html.indexOf("Sunday"));

    locale.current = "fr";
    const fr = render();
    locale.current = "en";
    expect(fr).toContain("lundi");
    expect(fr).toContain("dimanche");
    expect(fr).not.toContain("Monday");
  });

  it("names the month in the locale as well", () => {
    locale.current = "fr";
    const fr = render();
    locale.current = "en";
    expect(fr).toContain("septembre 2026");
  });

  it("offers a way back to today only when today is off screen", () => {
    expect(html).not.toContain("web.settings.blockedDates.today<");
    const elsewhere = render({ year: 2027, month0: 0 });
    expect(elsewhere).toContain("web.settings.blockedDates.today");
  });

  it("rings the block the list is pointing at", () => {
    const highlighted = render({ highlightedBlockId: "b1" });
    expect(highlighted).toContain("ring-destructive");
    expect(html).not.toContain("ring-destructive");
  });
});
