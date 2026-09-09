// @vitest-environment jsdom
//
// The inbox list's rendering contract. Every assertion here is something the
// old flat list got wrong and the redesign is answerable for: that a row says
// which KIND of event it is, that "unread" reaches a screen reader and not
// only an eye, that the timestamp is a machine-readable instant, and that a
// chevron is only ever shown where there is somewhere to go.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

// The components compile with the classic JSX runtime (React must be in scope).
(globalThis as Record<string, unknown>).React = React;

// Echo the key, so assertions key off structure rather than copy.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars
    ? `${key}(${Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key;

// The row's <form action> is a server action; importing the real module would
// drag auth and Prisma into a jsdom test for no gain. What matters here is the
// markup around it.
vi.mock("@/app/(app)/notifications/actions", () => ({
  openNotificationAction: vi.fn(),
  markAllReadAction: vi.fn(),
}));

const { NotificationList } = await import("@/app/(app)/notifications/notification-list");

type Item = import("@/app/(app)/notifications/notification-list").NotificationListItem;

// The unread edge, asserted as a SET of classes rather than as the string
// `class=` happens to hold. The order inside that attribute is decided by
// prettier-plugin-tailwindcss and changes on a version bump — #1103 took it
// 0.6.14 → 0.8.1 and turned `bg-primary absolute …` into `absolute … bg-primary`,
// which made a formatter upgrade read as a regression in the unread marker.
// Counting elements that carry all of these says the same thing and cannot.
const EDGE_CLASSES = ["absolute", "inset-y-0", "left-0", "w-0.5", "bg-primary"];
const unreadEdges = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)]
    .map((m) => new Set(m[1].split(/\s+/)))
    .filter((classes) => EDGE_CLASSES.every((c) => classes.has(c)));

const TZ = "America/Mexico_City";
// 2026-09-02 18:00 UTC is 12:00 on 2026-09-02 in Mexico City.
const NOW = new Date("2026-09-02T18:00:00.000Z");

const CTX = {
  locale: "en" as const,
  t,
  timezone: TZ,
  now: NOW,
  returnHref: "/notifications?show=unread",
};

function item(over: Partial<Item> = {}): Item {
  return {
    id: "n1",
    templateName: "payment_received_teacher",
    title: "Marcela paid for 8 classes",
    body: "1,200 MXN received.",
    href: "/payments/p1",
    createdAt: new Date("2026-09-02T16:30:00.000Z"),
    read: false,
    ...over,
  };
}

const render = (items: Item[], props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<NotificationList items={items} ctx={CTX} {...props} />);

describe("NotificationList — what a row says", () => {
  it("marks each kind of event with its own icon and tone", () => {
    const html = render([
      item({ id: "a", templateName: "payment_received_teacher" }),
      item({ id: "b", templateName: "reminder_1h_teacher" }),
      item({ id: "c", templateName: "account_disabled_teacher" }),
    ]);
    // A sale is the success tone, a reminder the neutral-information one, and
    // an account that cannot take money the alarm — the only one that gets it.
    expect(html).toContain("bg-success-bg");
    expect(html).toContain("bg-info-bg");
    expect(html).toContain("bg-destructive-bg");
  });

  it("gives an unknown template a mark rather than dropping the row", () => {
    const html = render([item({ templateName: "a_template_from_a_later_deploy" })]);
    expect(html).toContain("bg-muted");
    expect(html).toContain("Marcela paid for 8 classes");
  });

  it("says 'unread' in words, not only in colour", () => {
    const html = render([item({ read: false })]);
    expect(html).toContain("web.notifications.unreadMarker");
    // …and carries the visual edge as well.
    expect(unreadEdges(html)).toHaveLength(1);
  });

  it("says nothing extra on a row that has been read", () => {
    const html = render([item({ read: true })]);
    expect(html).not.toContain("web.notifications.unreadMarker");
    expect(unreadEdges(html)).toHaveLength(0);
  });

  // REGRESSION. The edge started life as `border-l-2 border-primary` on the
  // <li>. Tailwind's `divide-border` on the enclosing <ul> compiles to a
  // `border-color` on `> * ~ *`, which outranks a border colour set on the row
  // itself — so every row but the first rendered a grey rule regardless of
  // read state, and the page's most important distinction vanished. The edge
  // must not be a border on an element the divide utility also styles.
  it("does not paint the unread edge with a border the list's divide can recolour", () => {
    const html = render([item({ id: "a", read: false }), item({ id: "b", read: false })]);
    expect(html).not.toContain("border-l-2");
    expect(unreadEdges(html)).toHaveLength(2);
  });

  it("renders the timestamp as a machine-readable instant in the teacher's zone", () => {
    const html = render([item({ createdAt: new Date("2026-09-02T16:30:00.000Z") })]);
    // React 19 serialises the attribute in its camelCase spelling; HTML
    // attribute names are ASCII case-insensitive, so `time[datetime]` still
    // matches in a browser and in assistive tech.
    expect(html).toMatch(/dateTime="2026-09-02T16:30:00\.000Z"/i);
    // 16:30 UTC is 10:30 in Mexico City, and en-US is a 12-hour locale.
    expect(html).toMatch(/>10:30\s*AM</);
  });

  it("carries the id, the destination and the view to return to", () => {
    const html = render([item({ id: "n7", href: "/payments/p1" })]);
    expect(html).toContain('name="id" value="n7"');
    expect(html).toContain('name="href" value="/payments/p1"');
    expect(html).toContain('name="return" value="/notifications?show=unread"');
  });

  it("promises a destination only when there is one", () => {
    // The chevron is the row's only claim that tapping goes somewhere.
    const withHref = render([item({ id: "a", href: "/payments/p1" })]);
    const without = render([item({ id: "b", href: null })]);
    const chevrons = (html: string) => (html.match(/lucide-chevron-right/g) ?? []).length;
    expect(chevrons(withHref)).toBe(1);
    expect(chevrons(without)).toBe(0);
    expect(without).toContain('name="href" value=""');
  });

  it("omits the body line entirely when a template has none", () => {
    const html = render([item({ body: "" })]);
    expect(html).toContain("Marcela paid for 8 classes");
    expect(html).not.toContain("1,200 MXN received.");
  });
});

describe("NotificationList — how the days are structured", () => {
  it("heads each day and puts its rows in their own list", () => {
    const html = render([
      item({ id: "a", createdAt: new Date("2026-09-02T16:00:00.000Z") }),
      item({ id: "b", createdAt: new Date("2026-09-02T15:00:00.000Z") }),
      item({ id: "c", createdAt: new Date("2026-09-01T15:00:00.000Z") }),
    ]);
    expect(html).toContain("web.notifications.group.today");
    expect(html).toContain("web.notifications.group.yesterday");
    // Real headings and one <ul> per day, so a screen reader gets the day's
    // count rather than one list of ninety.
    expect((html.match(/<h2/g) ?? []).length).toBe(2);
    expect((html.match(/<ul/g) ?? []).length).toBe(2);
    expect((html.match(/<li/g) ?? []).length).toBe(3);
  });

  it("rounds off the last group only when nothing follows the list", () => {
    const rows = [item()];
    expect(render(rows)).toContain("rounded-b-lg");
    expect(render(rows, { roundedBottom: false })).not.toContain("rounded-b-lg");
  });

  it("renders nothing at all for an empty page", () => {
    expect(render([])).not.toContain("<li");
  });
});
