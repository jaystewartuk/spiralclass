// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

// The components compile with the classic JSX runtime (React must be in scope).
(globalThis as Record<string, unknown>).React = React;

// Echo the key, with `{var}` still interpolated, so assertions key off
// structure and colour rather than copy — except where the point IS the copy
// (the legend's agreement with the row labels), which uses the vars.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars
    ? `${key}(${Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key;

vi.mock("@/lib/i18n", () => ({ getT: async () => t }));

const { CalendarMonth } = await import("@/components/calendar/calendar-month");
const { TimeGrid } = await import("@/components/calendar/time-grid");
const { CalendarLegend } = await import("@/components/calendar/calendar-legend");

type Ev = import("@/components/calendar/event").CalendarEvent;

function ev(over: Partial<Ev> & { ymd: string; startMinutes: number }): Ev {
  return {
    id: `${over.ymd}-${over.startMinutes}`,
    href: "/dashboard/classes/x",
    startUtc: new Date(`${over.ymd}T09:00:00.000Z`),
    durationMinutes: 60,
    timeLabel: "09:00",
    title: "María González",
    status: "scheduled",
    ...over,
  } as Ev;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  no_show: "No-show",
  canceled_by_student: "Cancelled (student)",
  canceled_by_teacher: "Cancelled (you)",
  rescheduled: "Rescheduled",
};
const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;

const MONTH_PROPS = {
  year: 2026,
  month0: 8, // September 2026
  selectedYmd: "2026-09-01",
  todayYmd: "2026-09-01",
  locale: "en" as const,
  basePath: "/dashboard/calendar",
  statusLabel,
  emptyDayText: "No classes this day.",
};

async function renderMonth(events: Ev[]) {
  return renderToStaticMarkup(await CalendarMonth({ ...MONTH_PROPS, events }));
}

describe("month grid typography", () => {
  // THE BUG THIS FILE EXISTS FOR. `text-label` was the 11px step of the shared
  // type scale; D-140 DELETED that step (packages/shared/src/tokens.ts explains
  // why — it was below the 15px floor the same decision states) and Tailwind
  // emits nothing for a class it cannot resolve, silently. So every event chip
  // in the month grid and every block and hour label in the week grid rendered
  // at the inherited 17px body size inside boxes measured for 11px, clipping
  // student names through the middle of the glyphs.
  //
  // Nothing failed. There is no test that can catch "a class name resolves to
  // no CSS" in general, so this catches the specific one that did.
  it("uses no type step that the scale no longer defines", async () => {
    const html = await renderMonth([ev({ ymd: "2026-09-01", startMinutes: 540 })]);
    expect(html).not.toContain("text-label");
  });
});

describe("month grid cells", () => {
  it("names each day and its class count for assistive tech", async () => {
    const html = await renderMonth([
      ev({ ymd: "2026-09-01", startMinutes: 540 }),
      ev({ ymd: "2026-09-01", startMinutes: 660, timeLabel: "11:00" }),
    ]);
    // The cell shows a number and some coloured marks; only the label says what
    // it is. Two classes on the 1st, and the count comes from the plural key.
    expect(html).toContain("web.calendar.dayCellLabel(day=Tue, Sep 1,classes=");
    expect(html).toContain("classCount(count=2)");
  });

  it("says so when a day is empty rather than leaving the cell unnamed", async () => {
    const html = await renderMonth([]);
    expect(html).toContain("web.calendar.noClasses");
  });

  it("paints every cell background OPAQUE", async () => {
    // The 1px rules between cells are the container's `bg-border` showing
    // through a `gap-px`, so a translucent cell fill composites over BORDER
    // GREY rather than over the card — which is how the spill-over week came to
    // render as a solid slate slab, and (in dark mode) as a row LIGHTER than
    // the page it was supposed to recede behind.
    const html = await renderMonth([]);
    const cellClasses = [...html.matchAll(/class="([^"]*min-h-cell[^"]*)"/g)].map((m) => m[1]);
    expect(cellClasses.length).toBeGreaterThan(0);
    for (const classes of cellClasses) {
      expect(classes, classes).not.toMatch(/\bbg-[a-z-]+\/\d+/);
    }
  });

  it("drops a trailing week that is entirely next month", async () => {
    // September 2026 ends on a Wednesday, so the sixth row would be 5–11 Oct.
    const html = await renderMonth([]);
    expect(html).toContain("d=2026-10-04");
    expect(html).not.toContain("d=2026-10-05");
  });
});

describe("agenda rows", () => {
  it("labels the exceptions and keeps the routine case visually quiet", async () => {
    const html = await renderMonth([
      ev({ ymd: "2026-09-01", startMinutes: 540 }),
      ev({
        ymd: "2026-09-01",
        startMinutes: 1080,
        timeLabel: "18:00",
        status: "canceled_by_student",
      }),
    ]);
    // A blue dot on a future date already says "scheduled"; spelling it out on
    // every row is what stops "cancelled" from standing out. So the routine
    // label is present for a screen reader and hidden from the eye.
    expect(html).toContain("sr-only");
    expect(html).toContain("Cancelled (student)");
  });

  it("carries the duration, which the old row had nowhere to put", async () => {
    const html = await renderMonth([
      ev({ ymd: "2026-09-01", startMinutes: 540, durationMinutes: 90 }),
    ]);
    expect(html).toContain("durationMin(count=90)");
  });
});

describe("legend", () => {
  it("takes its wording from the caller, so it cannot disagree with the rows", () => {
    // It used to read `booking.status.canceled` itself while the chip three
    // inches away read `web.dashboard.calendar.status.canceledByStudent` —
    // "Canceled" beside "Cancelled (student)", two spellings of one word.
    const html = renderToStaticMarkup(<CalendarLegend statusLabel={statusLabel} t={t} />);
    expect(html).toContain("Cancelled (student)");
    expect(html).not.toContain("Canceled<");
  });
});

describe("time grid", () => {
  const gridProps = {
    locale: "en" as const,
    dayHref: (d: string) => `/dashboard/calendar?v=day&d=${d}`,
    t,
  };

  it("labels every hour on the axis, including the first", () => {
    // The labels were centred on their own rule, which put the topmost one half
    // outside the grid — so it was blanked, leaving the hour that most often
    // holds the first class of the day as the only unlabelled row.
    const html = renderToStaticMarkup(
      <TimeGrid
        {...gridProps}
        days={[{ ymd: "2026-09-01" }]}
        todayYmd="2026-09-01"
        events={[ev({ ymd: "2026-09-01", startMinutes: 540 })]}
      />,
    );
    expect(html).toContain("07:00");
    expect(html).toContain("20:00");
  });

  it("draws the current-time rule only when today is on screen", () => {
    const withToday = renderToStaticMarkup(
      <TimeGrid
        {...gridProps}
        days={[{ ymd: "2026-09-01" }]}
        todayYmd="2026-09-01"
        events={[ev({ ymd: "2026-09-01", startMinutes: 540 })]}
        nowMinutes={11 * 60}
        timeZone="America/Mexico_City"
      />,
    );
    expect(withToday).toContain("web.calendar.currentTime");

    const otherDay = renderToStaticMarkup(
      <TimeGrid
        {...gridProps}
        days={[{ ymd: "2026-09-02" }]}
        todayYmd="2026-09-01"
        events={[ev({ ymd: "2026-09-02", startMinutes: 540 })]}
        nowMinutes={11 * 60}
        timeZone="America/Mexico_City"
      />,
    );
    expect(otherDay).not.toContain("web.calendar.currentTime");
  });

  it("does not draw the rule when now falls outside the rendered hours", () => {
    const html = renderToStaticMarkup(
      <TimeGrid
        {...gridProps}
        days={[{ ymd: "2026-09-01" }]}
        todayYmd="2026-09-01"
        events={[ev({ ymd: "2026-09-01", startMinutes: 540 })]}
        nowMinutes={3 * 60} // 03:00, above the 07:00 default window
        timeZone="America/Mexico_City"
      />,
    );
    expect(html).not.toContain("web.calendar.currentTime");
  });

  it("draws no rule without a zone to keep it right with", () => {
    // A server-positioned line is exact once and wrong from then on. The zone
    // is what CurrentTimeLine recomputes from, so a caller that supplies a
    // position but no zone is asking for a line that will silently go stale —
    // and gets no line instead.
    const html = renderToStaticMarkup(
      <TimeGrid
        {...gridProps}
        days={[{ ymd: "2026-09-01" }]}
        todayYmd="2026-09-01"
        events={[ev({ ymd: "2026-09-01", startMinutes: 540 })]}
        nowMinutes={11 * 60}
      />,
    );
    expect(html).not.toContain("web.calendar.currentTime");
  });

  it("server-renders the rule at its initial position, so it survives no-JS", () => {
    // The point of passing a server-resolved `nowMinutes` at all: the line is
    // in the right place at first paint and does not jump on hydration.
    // 11:00 in a 07:00-start grid at 64px an hour = 4 hours down.
    const html = renderToStaticMarkup(
      <TimeGrid
        {...gridProps}
        days={[{ ymd: "2026-09-01" }]}
        todayYmd="2026-09-01"
        events={[ev({ ymd: "2026-09-01", startMinutes: 540 })]}
        nowMinutes={11 * 60}
        timeZone="America/Mexico_City"
      />,
    );
    expect(html).toContain("top:256px");
  });

  it("omits the column header on a one-day grid", () => {
    // The range header directly above already names the day in full, and the
    // header's link pointed at the page you are already on.
    const oneDay = renderToStaticMarkup(
      <TimeGrid
        {...gridProps}
        days={[{ ymd: "2026-09-01" }]}
        todayYmd="2026-09-01"
        events={[ev({ ymd: "2026-09-01", startMinutes: 540 })]}
      />,
    );
    expect(oneDay).not.toContain("v=day&amp;d=2026-09-01");

    const week = renderToStaticMarkup(
      <TimeGrid
        {...gridProps}
        days={[{ ymd: "2026-08-31" }, { ymd: "2026-09-01" }]}
        todayYmd="2026-09-01"
        events={[ev({ ymd: "2026-09-01", startMinutes: 540 })]}
      />,
    );
    expect(week).toContain("v=day&amp;d=2026-09-01");
  });

  it("keeps a short class on one line so its name is not clipped out of it", () => {
    // A 30-minute block is 32px tall at a 64px hour. Two 15px lines do not fit,
    // and the old two-line block simply cropped the second one — which is the
    // student's name, i.e. the only part worth reading.
    const html = renderToStaticMarkup(
      <TimeGrid
        {...gridProps}
        days={[{ ymd: "2026-09-01" }]}
        todayYmd="2026-09-01"
        events={[ev({ ymd: "2026-09-01", startMinutes: 540, durationMinutes: 30, title: "Tom" })]}
      />,
    );
    expect(html).toContain("Tom");
    expect(html).toMatch(/items-center gap-1\.5|gap-1\.5[^"]*items-center/);
  });
});
