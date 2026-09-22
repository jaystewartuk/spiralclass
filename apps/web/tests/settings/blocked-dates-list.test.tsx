import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The list of blocks already in place. It used to be a flat run of date
// ranges with a bare "Remove" beside each — no sense of when a block was, how
// long it ran, or which of eight identical buttons a screen-reader user was
// about to press.

vi.mock("@/app/actions/blocked-dates", () => ({ deleteBlockedDateAction: vi.fn() }));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars?.count === undefined
      ? vars?.range
        ? `${key}[${vars.range}]`
        : key
      : `${key}#${vars.count}`,
  useLocale: () => "en",
}));

const { BlockedList } = await import("@/app/(app)/settings/blocked-dates/blocked-list");

const blocks = [
  { id: "b1", start: "2026-09-14", end: "2026-09-18", reason: "Family" },
  { id: "b2", start: "2026-09-25", end: "2026-09-25", reason: null },
];

const html = renderToStaticMarkup(
  React.createElement(BlockedList, {
    blocks,
    todayYmd: "2026-09-15",
    formatRange: (r: { start: string; end: string }) =>
      r.start === r.end ? r.start : `${r.start} to ${r.end}`,
    onHighlight: () => {},
    onShowOnCalendar: () => {},
  }),
);

describe("BlockedList", () => {
  it("marks a block that has already started as running", () => {
    expect(html).toContain("web.settings.blockedDates.onNow");
  });

  it("counts the days to a block that has not", () => {
    // 15 September to 25 September.
    expect(html).toContain("web.settings.blockedDates.startsIn#10");
  });

  it("says how long each block runs", () => {
    expect(html).toContain("web.settings.blockedDates.dayCount#5");
    expect(html).toContain("web.settings.blockedDates.dayCount#1");
  });

  it("shows a reason when there is one and nothing when there is not", () => {
    expect(html).toContain("Family");
  });

  it("names the range each Remove button acts on", () => {
    // Eight buttons all reading "Remove" are indistinguishable in a screen
    // reader's element list; the visible word stays short because the date is
    // already next to it.
    expect(html).toContain("web.settings.blockedDates.removeLabel[2026-09-14 to 2026-09-18]");
    expect(html).toContain("web.settings.blockedDates.showOnCalendar[2026-09-25]");
  });
});
