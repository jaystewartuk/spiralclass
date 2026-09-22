import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

// The rebuilt /dashboard/discounts list. Its whole claim is that the row TELLS
// THE TRUTH about a code — the old one rendered only the `active` column, so an
// expired code and a code that had spent its last redemption both looked
// exactly like a working one, and the first thing that said otherwise was the
// student's checkout. These pin the properties that claim rests on, none of
// which the type system can.

// Only ever handed to useActionState here; importing the real module would drag
// prisma and auth into a view test.
vi.mock("@/app/actions/discounts", () => ({
  createDiscountCode: async () => undefined,
  setDiscountCodeActive: async () => undefined,
  deleteDiscountCode: async () => undefined,
}));

const { DiscountGroup } = await import("@/app/(app)/dashboard/discounts/discount-list");
const { CreateDiscountForm } = await import("@/app/(app)/dashboard/discounts/discount-forms");
const { LocaleProvider } = await import("@/components/locale-provider");
const { PricingCurrencyProvider } = await import("@/components/pricing-currency-context");
type Row = Parameters<typeof DiscountGroup>[0]["rows"][number];

const NOW = new Date("2026-09-02T12:00:00.000Z");

const CTX = {
  t: createT("en"),
  locale: "en" as const,
  now: NOW,
  checkoutBase: "https://spiralclass.com/b/mira/buy",
};

const row = (over: Partial<Row> = {}): Row => ({
  id: "11111111-1111-4111-8111-111111111111",
  code: "SUMMER25",
  kind: "percent",
  percentBps: 1500,
  amountMinorUnits: null,
  currency: "GBP",
  active: true,
  maxRedemptions: null,
  perStudentLimit: 1,
  expiresAt: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  state: "live",
  totals: { used: 0, givenMinorUnits: 0, salesMinorUnits: 0 },
  ...over,
});

function render(rows: Row[], title = "Live") {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <DiscountGroup title={title} rows={rows} ctx={CTX} />
    </LocaleProvider>,
  );
}

describe("a live code", () => {
  const html = render([row({ maxRedemptions: 10, perStudentLimit: 1 })]);

  it("says it is live, and what it takes off", () => {
    expect(html).toContain("SUMMER25");
    expect(html).toContain("15% off");
    expect(html).toContain("Live");
  });

  it("reads its usage as a sentence rather than a 3/10 fraction", () => {
    expect(html).toContain("0 of 10 used");
    expect(html).toContain("One per student");
  });

  it("offers the checkout link with the code already in it", () => {
    // ?ref= on /b/<slug>/buy is what opens the discount box and fills the code
    // in — the reason this button exists at all.
    expect(html).toContain("Copy the checkout link for SUMMER25");
  });

  it("offers to pause it, naming the code so a list of six is navigable", () => {
    expect(html).toContain('aria-label="Pause SUMMER25"');
  });
});

describe("a code that no longer works", () => {
  it("says EXPIRED, which the old row could not say at all", () => {
    const html = render([
      row({ expiresAt: new Date("2026-08-31T23:59:59.999Z"), state: "expired" }),
    ]);
    expect(html).toContain("Expired");
  });

  it("says FULLY USED when the cap is spent", () => {
    const html = render([
      row({
        maxRedemptions: 5,
        state: "usedUp",
        totals: { used: 5, givenMinorUnits: 6000, salesMinorUnits: 34000 },
      }),
    ]);
    expect(html).toContain("Fully used");
    expect(html).toContain("5 of 5 used");
  });

  it("does not offer a link that would fail at the till", () => {
    const html = render([
      row({ expiresAt: new Date("2026-08-31T23:59:59.999Z"), state: "expired" }),
    ]);
    expect(html).not.toContain("Copy the checkout link");
  });

  it("does not offer a toggle that could not revive it", () => {
    // `active` is still true on an expired code. A Pause button there implies
    // the state is hers to change, and it is not.
    const html = render([
      row({ expiresAt: new Date("2026-08-31T23:59:59.999Z"), state: "expired" }),
    ]);
    expect(html).not.toContain('aria-label="Pause SUMMER25"');
  });

  it("still offers Resume on a paused code, which IS hers to change", () => {
    const html = render([row({ active: false, state: "paused" })]);
    expect(html).toContain("Paused");
    expect(html).toContain('aria-label="Resume SUMMER25"');
  });
});

describe("warnings", () => {
  it("counts down an expiry that is close", () => {
    const html = render([row({ expiresAt: new Date("2026-09-05T23:59:59.999Z") })]);
    expect(html).toContain("3 days left");
  });

  it("names the last day rather than counting zero days", () => {
    const html = render([row({ expiresAt: new Date("2026-09-02T23:59:59.999Z") })]);
    expect(html).toContain("Last day");
  });

  it("shows one warning, not two, when both ends are close", () => {
    const html = render([
      row({
        expiresAt: new Date("2026-09-04T23:59:59.999Z"),
        maxRedemptions: 10,
        totals: { used: 9, givenMinorUnits: 9000, salesMinorUnits: 50000 },
      }),
    ]);
    expect(html).toContain("1 use left");
    expect(html).not.toContain("2 days left");
  });
});

describe("what a code has cost", () => {
  it("states the discount given and the sales it rode on", () => {
    // DiscountRedemption.amountMinorUnits has recorded this since the table
    // existed; nothing on the dashboard read it.
    const html = render([
      row({ totals: { used: 3, givenMinorUnits: 4500, salesMinorUnits: 32000 } }),
    ]);
    expect(html).toContain("Used 3 times");
    // formatMinorUnits appends the ISO code — the dashboard-wide convention,
    // and the reason an MXN teacher's "$450.00" cannot be read as dollars.
    expect(html).toContain("£45.00 GBP given away, on £320.00 GBP of sales");
  });

  it("says nothing about money on a code nobody has used", () => {
    const html = render([row()]);
    expect(html).toContain("Not used yet");
    expect(html).not.toContain("of sales");
  });

  it("reports the discount alone when the purchase has not settled", () => {
    const html = render([row({ totals: { used: 1, givenMinorUnits: 2000, salesMinorUnits: 0 } })]);
    // "given away", not "off": on a fixed-amount code used once the two
    // would otherwise be the same string printed twice in one row.
    expect(html).toContain("£20.00 GBP given away");
    expect(html).not.toContain("of sales");
  });
});

describe("the expiry date", () => {
  it("renders on the reader's calendar, not as an ISO slice", () => {
    const html = render([row({ expiresAt: new Date("2026-12-31T23:59:59.999Z") })]);
    expect(html).toContain("Ends Dec 31, 2026");
    expect(html).not.toContain("2026-12-31");
  });

  it("keeps the day the teacher picked, which is a UTC day", () => {
    // Stored as end-of-day UTC. Formatting it in a western zone would show the
    // 30th to a teacher who typed the 31st.
    const html = render([row({ expiresAt: new Date("2026-12-31T23:59:59.999Z") })]);
    expect(html).not.toContain("Dec 30");
  });
});

describe("deleting", () => {
  it("offers delete on a code nobody has used", () => {
    expect(render([row()])).toContain('aria-label="Delete SUMMER25"');
  });

  it("withholds it once the code has been used, so its cost stays on the record", () => {
    const html = render([
      row({ totals: { used: 1, givenMinorUnits: 2000, salesMinorUnits: 8000 } }),
    ]);
    expect(html).not.toContain('aria-label="Delete SUMMER25"');
  });
});

describe("the group itself", () => {
  it("is a heading over a list, so it is navigable and countable", () => {
    const html = render([row(), row({ id: "b", code: "OTOÑO" })]);
    expect(html).toContain("<h2");
    expect(html).toContain("<ul");
    expect((html.match(/<li/g) ?? []).length).toBe(2);
  });

  it("renders nothing at all when its half is empty", () => {
    expect(render([], "Not redeemable")).toBe("");
  });
});

describe("the create form", () => {
  const html = renderToStaticMarkup(
    <LocaleProvider locale="en">
      {/* Her own pricing currency (D-64), which is what the fixed-amount half
          of the switch has to be denominated in. */}
      <PricingCurrencyProvider currency="GBP">
        <CreateDiscountForm />
      </PricingCurrencyProvider>
    </LocaleProvider>,
  );

  it("makes the percent/fixed switch a real radio group", () => {
    // It was two <Button>s and a useState: a segmented control to a mouse, and
    // nothing at all in the accessibility tree — no group, no selected state,
    // no arrow keys, and a control whose whole accessible name was "%".
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect((html.match(/type="radio"/g) ?? []).length).toBe(2);
    expect(html).toContain('name="kind"');
  });

  it("names the two options in words, so the visible label IS the accessible name", () => {
    expect(html).toContain("Percent");
    expect(html).toContain("Fixed GBP");
    expect(html).not.toContain(">%<");
  });

  it("attaches each field's help text to the field, not just near it", () => {
    // aria-describedby, so the guidance is read on focus rather than only seen.
    expect(html).toMatch(/aria-describedby="[^"]*-code-help"/);
    expect(html).toMatch(/aria-describedby="[^"]*-per-help"/);
    expect(html).toMatch(/aria-describedby="[^"]*-exp-help"/);
  });

  it("says 'Unlimited' rather than an infinity glyph a screen reader must guess at", () => {
    expect(html).toContain('placeholder="Unlimited"');
    expect(html).not.toContain("∞");
  });

  it("cannot offer an expiry that is already in the past", () => {
    expect(html).toContain(`min="${new Date().toISOString().slice(0, 10)}"`);
  });
});
