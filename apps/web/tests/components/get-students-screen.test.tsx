import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT, pageReadiness, planProgress, type PageSignals } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

// The "Get students" weekly screen after the polish pass.
//
// Every assertion here pins a property the type system cannot: which sentence
// leads, what a control is CALLED when a screen reader reaches it, whether a
// number arrives with the word it belongs to. Those are exactly the things the
// previous version got wrong while type-checking perfectly — `3 · 1 · 0` is a
// well-typed string.

const t = createT("en");
vi.mock("@/lib/i18n", () => ({
  getT: async () => createT("en"),
  getPreferredLocale: async () => "en",
}));

// Server actions are only ever handed to useActionState here; importing the
// real module would drag prisma and auth into a view test.
vi.mock("@/app/actions/marketing", () => ({
  markActivityDoneAction: async () => undefined,
  skipActivityAction: async () => undefined,
  regeneratePlanAction: async () => undefined,
}));

const { ActionRow, DoneRow, NextActionCard } =
  await import("@/app/(app)/dashboard/get-students/action-card");
const { PageReadinessCard } =
  await import("@/app/(app)/dashboard/get-students/page-readiness-card");
const { ResultsSummaryCard } =
  await import("@/app/(app)/dashboard/get-students/results-summary-card");
const { SectionNav } = await import("@/app/(app)/dashboard/get-students/section-nav");
const { WeekProgress } = await import("@/app/(app)/dashboard/get-students/week-progress");
const { LocaleProvider } = await import("@/components/locale-provider");

type Item = React.ComponentProps<typeof NextActionCard>["item"];

function item(over: Partial<Item> = {}): Item {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "testimonial",
    platform: "facebook_group",
    status: "planned",
    reason: { code: "best_community", community: "Oaxaca Expats", students: 2 },
    communityName: "Oaxaca Expats",
    studentName: null,
    results: { visits: 0, enquiries: 0, students: 0 },
    ...over,
  };
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    React.createElement(LocaleProvider, { locale: "en", children: node }),
  );
}

/** The one anchor in `html` pointing at `href`, so an assertion can be about
 * that link rather than about the order React emits attributes in. */
function anchorFor(html: string, href: string): string {
  const match = html.match(new RegExp(`<a [^>]*href="${href.replace(/[/?]/g, "\\$&")}"[^>]*>`));
  expect(match, `no anchor for ${href}`).not.toBeNull();
  return match![0];
}

/** Server Components are async functions returning JSX — await, then render. */
async function renderServer(element: Promise<React.ReactNode>) {
  return renderToStaticMarkup(await element);
}

describe("the next action", () => {
  const html = render(React.createElement(NextActionCard, { item: item() }));

  it("leads with the reason, not the content type", () => {
    // The reason is what turns a chore into advice. It was the third line, in
    // grey, under the summary.
    expect(html).toContain("Oaxaca Expats has already brought you 2 students.");
    const heading = html.indexOf("Oaxaca Expats has already brought you 2 students.");
    const task = html.indexOf("Share a testimonial");
    expect(heading).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(heading);
    // …and it is a heading, so it is reachable by heading navigation.
    expect(html).toMatch(/<h3[^>]*>Oaxaca Expats has already brought you 2 students\.<\/h3>/);
  });

  it("falls back to the task when the plan recorded no reason", () => {
    const bare = render(React.createElement(NextActionCard, { item: item({ reason: null }) }));
    expect(bare).toMatch(/<h3[^>]*>Share a testimonial<\/h3>/);
  });

  it("prices the action from the planner rather than a flat twelve", () => {
    expect(html).toContain("about 12 min");
    const referral = render(
      React.createElement(NextActionCard, {
        item: item({ kind: "referral_ask", platform: "whatsapp" }),
      }),
    );
    expect(referral).toContain("about 5 min");
  });

  it("offers prepare, done and skip", () => {
    expect(html).toContain("Prepare it");
    expect(html).toContain("Mark as done");
    expect(html).toContain("Not this week");
  });
});

describe("a row in the rest of the week", () => {
  const html = render(React.createElement(ActionRow, { item: item({ status: "ready" }) }));

  it("names its tick-off button after the action it completes", () => {
    // A column of buttons all called "Mark as done" is the same defect as a
    // column of links all called "Fix": the name has to say which row.
    expect(html).toContain('aria-label="Mark “Share a testimonial” as done"');
  });

  it("keeps the button OUT of the link — interactive content cannot nest", () => {
    const anchor = html.slice(html.indexOf("<a "), html.indexOf("</a>"));
    expect(anchor).not.toContain("<button");
    expect(html).toContain('href="/dashboard/get-students/11111111-1111-4111-8111-111111111111"');
  });

  it("says a prepared action is ready in a word, not only a colour", () => {
    expect(html).toContain("Ready to post");
  });
});

describe("a finished action", () => {
  it("states what it produced in words", () => {
    const html = render(
      React.createElement(DoneRow, {
        item: item({ status: "done", results: { visits: 9, enquiries: 2, students: 1 } }),
      }),
    );
    // Was `9 · 2 · 1`, which is a puzzle rather than a result.
    expect(html).toContain("Brought you a student");
    expect(html).toContain("Done");
  });

  it("reports the furthest step reached when nobody bought", () => {
    const enquiries = render(
      React.createElement(DoneRow, {
        item: item({ status: "done", results: { visits: 9, enquiries: 2, students: 0 } }),
      }),
    );
    expect(enquiries).toContain("2 enquiries");

    const nothing = render(
      React.createElement(DoneRow, {
        item: item({ status: "done", results: { visits: 0, enquiries: 0, students: 0 } }),
      }),
    );
    expect(nothing).toContain("No visits yet");
  });

  it("does not dim its own text to say it is finished", () => {
    // `opacity-60` on a whole card cut the contrast of text D-140 requires to
    // stay legible. Weight is carried by the section it sits in instead.
    const html = render(React.createElement(DoneRow, { item: item({ status: "skipped" }) }));
    expect(html).not.toContain("opacity-");
    expect(html).toContain("Skipped");
  });
});

describe("the week's progress", () => {
  it("counts done against done-plus-open and prices the remainder", async () => {
    const progress = planProgress([
      { kind: "tip", status: "done" },
      { kind: "tip", status: "planned" },
      { kind: "referral_ask", status: "ready" },
      { kind: "tip", status: "skipped" },
    ]);
    const html = await renderServer(WeekProgress({ progress }));
    expect(html).toContain("1 of 3 done");
    // 12 for the tip + 5 for the referral ask. The screen used to say 36.
    expect(html).toContain("About 17 min left");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="33"');
    expect(html).toContain('aria-label="Progress this week"');
  });

  it("renders nothing when there is no plan to be part-way through", async () => {
    expect(await renderServer(WeekProgress({ progress: planProgress([]) }))).toBe("");
  });
});

describe("the booking-page card", () => {
  const signals = (over: Partial<PageSignals> = {}): PageSignals => ({
    hasPhoto: true,
    headline: "Learn Spanish in Oaxaca",
    bio: "x".repeat(200),
    packageCount: 2,
    testimonialCount: 1,
    hasIntroVideo: true,
    introVideoOfferable: true,
    ...over,
  });
  const funnel = { visits: 40, enquiries: 0, bookings: 0, students: 0, revenueMinorUnits: 0 };

  it("makes every gap one link named after the gap itself", async () => {
    const readiness = pageReadiness(signals({ hasPhoto: false, packageCount: 0 }), funnel);
    const html = await renderServer(PageReadinessCard({ readiness, slug: "mira" }));
    // The old row was `<span>gap</span><Button>Fix</Button>` — so every gap in
    // the list announced itself as "Fix".
    expect(html).not.toContain(">Fix<");
    expect(anchorFor(html, "/settings/templates")).toBeTruthy();
    expect(anchorFor(html, "/settings/booking-page")).toBeTruthy();
    expect(html).toContain("Add a package people can buy");
    expect(html).toContain("Add a photo of yourself");
  });

  it("says in a word which gap stops a sale outright", async () => {
    const readiness = pageReadiness(signals({ packageCount: 0 }), funnel);
    const html = await renderServer(PageReadinessCard({ readiness, slug: "mira" }));
    expect(readiness.verdict).toBe("cannot_buy");
    expect(html).toContain("Blocking");
    // …and that the whole card outranks the week's posting, also in a word.
    expect(html).toContain("Fix this first");
  });

  it("leaves polish gaps unbadged so the severe ones still read as severe", async () => {
    // A quiet funnel on purpose: with 40 visits and nothing bought, the page
    // IS the bottleneck and the card correctly says so — which is a different
    // assertion from this one.
    const readiness = pageReadiness(signals({ testimonialCount: 0 }), { ...funnel, visits: 3 });
    const html = await renderServer(PageReadinessCard({ readiness, slug: "mira" }));
    expect(html).toContain("Add a few words from a student");
    expect(html).not.toContain("Blocking");
    expect(html).not.toContain("Important");
    expect(html).not.toContain("Fix this first");
  });

  it("renders nothing at all when the page is ready", async () => {
    const readiness = pageReadiness(signals(), funnel);
    expect(await renderServer(PageReadinessCard({ readiness, slug: "mira" }))).toBe("");
  });
});

describe("the last-30-days tile", () => {
  it("pairs every number with its own word, and leads somewhere", async () => {
    const html = await renderServer(
      ResultsSummaryCard({
        headline: { visits: 40, enquiries: 3, bookings: 1, students: 1, revenueMinorUnits: 0 },
      }),
    );
    // A <dl> is what makes "40" announce as "Visits, 40" rather than as "40".
    expect(html).toContain("<dl");
    expect(html).toContain("<dt");
    expect(html).toContain(t("web.getStudents.visits"));
    // It used to be the bottom of the page with nothing to click.
    expect(html).toContain('href="/dashboard/get-students/results"');
  });
});

describe("the section navigation", () => {
  it("is a named landmark that marks where you are", async () => {
    const html = await renderServer(SectionNav({ current: "communities" }));
    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="Get students"');
    expect(anchorFor(html, "/dashboard/get-students/communities")).toContain('aria-current="page"');
    expect(anchorFor(html, "/dashboard/get-students/results")).not.toContain("aria-current");
    // Every section is reachable from every other one, which is the point.
    for (const href of [
      "/dashboard/get-students",
      "/dashboard/get-students/communities",
      "/dashboard/get-students/results",
      "/dashboard/get-students/profile",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});
