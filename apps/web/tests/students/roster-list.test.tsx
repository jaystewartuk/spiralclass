import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

// The transpiled components reference a global `React` (classic JSX runtime),
// same arrangement as the other SSR tests on this surface.
(globalThis as Record<string, unknown>).React = React;

import { createT } from "@/lib/i18n-translate";
import type { RosterStudent } from "@/lib/students-list";
import { RosterList } from "@/app/(app)/dashboard/students/roster-list";
import { RosterListHeader, RosterToolbar } from "@/app/(app)/dashboard/students/roster-toolbar";

// The roster's rendered contract. These render through the REAL catalog rather
// than a `(key) => key` stub, so a missing or mis-named key fails here instead
// of shipping as a raw dot-path on the screen.

const TZ = "America/Mexico_City";
const NOW = new Date("2026-09-01T15:00:00.000Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const t = createT("en");

function student(overrides: Partial<RosterStudent> = {}): RosterStudent {
  return {
    studentId: "s1",
    name: "Mira López",
    email: "mira@correo.mx",
    phoneE164: null,
    linkedAt: new Date("2026-01-01T00:00:00.000Z"),
    archived: false,
    notLive: false,
    levelLabel: null,
    agreedPriceCount: 0,
    activePackage: { total: 8, left: 5, expiresAt: inDays(90) },
    hasUpcomingClass: true,
    ...overrides,
  };
}

const renderRoster = (students: RosterStudent[]) =>
  renderToStaticMarkup(React.createElement(RosterList, { students, now: NOW, timezone: TZ, t }));

describe("RosterList — the balance column", () => {
  it("shows the classes left as a figure, with the total under it", () => {
    const html = renderRoster([student()]);
    expect(html).toContain("5 left");
    expect(html).toContain("of 8");
  });

  it("reads as a whole sentence to a screen reader", () => {
    // "of 8" on its own line is a fragment out of context, so the visible
    // split is aria-hidden and this is what is actually announced.
    expect(renderRoster([student()])).toContain("5 of 8 classes left to teach");
  });

  it("says how low the balance is in the number, not only in the colour", () => {
    // The ~8% of readers who cannot separate the amber from the grey still
    // read "1 left". The tone is reinforcement.
    const html = renderRoster([student({ activePackage: { total: 8, left: 1, expiresAt: null } })]);
    expect(html).toContain("1 left");
    expect(html).toContain("text-warning");
  });

  it("colours a spent package as urgently as one that is nearly spent", () => {
    // Zero is the most urgent balance there is, and it is the one the
    // low-balance flag deliberately excludes — so it used to render in the
    // same neutral ink as a full package.
    const html = renderRoster([student({ activePackage: { total: 8, left: 0, expiresAt: null } })]);
    expect(html).toContain("0 left");
    expect(html).toContain("text-warning");
  });

  it("names the absence rather than printing a zero", () => {
    const html = renderRoster([student({ activePackage: null })]);
    expect(html).toContain("No package");
    expect(html).not.toContain("left");
  });

  it("links the whole row to the student", () => {
    expect(renderRoster([student()])).toContain('href="/dashboard/students/s1"');
  });

  it("falls back to the phone, then to a label, when there is no email", () => {
    expect(renderRoster([student({ email: null, phoneE164: "+525512345678" })])).toContain(
      "+525512345678",
    );
    expect(renderRoster([student({ email: null, phoneE164: null })])).toContain("no email");
  });
});

describe("RosterList — the note chip", () => {
  it("says nothing about a healthy student", () => {
    const html = renderRoster([student()]);
    for (const note of ["Package expired", "Expires in", "No class booked"]) {
      expect(html).not.toContain(note);
    }
  });

  it("shows ONE note, the most urgent, not every true statement", () => {
    // Expired, running low and nothing booked are all true here.
    const html = renderRoster([
      student({
        activePackage: { total: 8, left: 1, expiresAt: inDays(-2) },
        hasUpcomingClass: false,
      }),
    ]);
    expect(html).toContain("Package expired");
    expect(html).not.toContain("No class booked");
  });

  it("pluralises the expiry countdown", () => {
    expect(
      renderRoster([student({ activePackage: { total: 8, left: 4, expiresAt: inDays(1) } })]),
    ).toContain("Expires in 1 day<");
    expect(
      renderRoster([student({ activePackage: { total: 8, left: 4, expiresAt: inDays(6) } })]),
    ).toContain("Expires in 6 days");
  });

  it("says 'today' rather than 'in 0 days'", () => {
    expect(
      renderRoster([student({ activePackage: { total: 8, left: 4, expiresAt: inDays(0) } })]),
    ).toContain("Expires today");
  });

  it("flags credit with nothing on the calendar", () => {
    expect(renderRoster([student({ hasUpcomingClass: false })])).toContain("No class booked");
  });

  it("does not repeat the balance it sits beside", () => {
    // A "1 class left" chip next to a column reading "1 left" is the same
    // sentence twice, and it would crowd out the fact the column cannot show.
    const html = renderRoster([student({ activePackage: { total: 8, left: 1, expiresAt: null } })]);
    expect(html).not.toContain("class left<");
  });
});

describe("RosterList — the other chips", () => {
  it("shows the hold, the level and the agreed-price count", () => {
    const html = renderRoster([student({ notLive: true, levelLabel: "B1", agreedPriceCount: 2 })]);
    expect(html).toContain("Not live");
    expect(html).toContain("B1");
    expect(html).toContain("2 agreed prices");
  });

  it("pluralises the agreed-price count", () => {
    expect(renderRoster([student({ agreedPriceCount: 1 })])).toContain("1 agreed price<");
  });
});

describe("RosterList — archived rows", () => {
  it("de-emphasises by removing colour, never by lowering opacity", () => {
    // The section used to carry `opacity-70`, which multiplied through the
    // muted text underneath it and dropped it below AA. De-emphasis must not
    // make text unreadable.
    const html = renderRoster([student({ archived: true })]);
    expect(html).toContain("grayscale");
    expect(html).not.toMatch(/opacity-\d/);
  });
});

describe("RosterToolbar", () => {
  const render = (props: Partial<React.ComponentProps<typeof RosterToolbar>> = {}) =>
    renderToStaticMarkup(
      React.createElement(RosterToolbar, {
        scope: "active" as const,
        search: "",
        sort: "recent" as const,
        attentionCount: 0,
        t,
        ...props,
      }),
    );

  it("marks the current view with aria-current, not colour alone", () => {
    expect(render({ scope: "archived" })).toContain('aria-current="page"');
  });

  it("badges the attention count only when there is something to do", () => {
    expect(render({ attentionCount: 0 })).not.toContain(">0<");
    expect(render({ attentionCount: 3 })).toContain(">3<");
  });

  it("carries the search and the order across a change of view", () => {
    const html = render({ search: "Mira", sort: "balance" });
    expect(html).toContain("show=attention&amp;q=Mira&amp;sort=balance");
  });

  it("keeps the view and the order on the search form, so a search does not reset them", () => {
    const html = render({ scope: "archived", sort: "name" });
    expect(html).toContain('name="show" value="archived"');
    expect(html).toContain('name="sort" value="name"');
  });

  it("offers a way out of a search only while there is one", () => {
    expect(render({ search: "" })).not.toContain("Clear");
    expect(render({ search: "Mira" })).toContain("Clear");
  });
});

describe("RosterListHeader", () => {
  const render = (count: number, sort: "recent" | "name" | "balance" = "recent") =>
    renderToStaticMarkup(
      React.createElement(RosterListHeader, {
        scope: "active" as const,
        search: "",
        sort,
        count,
        t,
      }),
    );

  it("says how many rows are in the list, pluralised", () => {
    expect(render(1)).toContain("1 student<");
    expect(render(12)).toContain("12 students");
  });

  it("marks the active order without making it a second 'page'", () => {
    // Re-ordering a list does not make it a different page; `aria-current="page"`
    // is specified as "the current page within a set of pages".
    const html = render(3, "balance");
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain('aria-current="page"');
  });
});
