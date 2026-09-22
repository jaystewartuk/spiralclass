import { describe, it, expect } from "vitest";
import { heroSpecs, heroStudentEmails, lockedPriceFor } from "../../scripts/seed";
import { PLAN_PRICE_MINOR_UNITS } from "@/lib/subscriptions/config";
import { currencyExponent } from "@spiralclass/shared";

// Guards the seed's static spec table. A runtime seed run would blow up on a
// duplicate booking slug / teacher email (both @unique), and the preview value
// of the seed is its subscription-matrix coverage — so assert both here, where
// the failure is a fast unit test rather than a failed promote-gate seed.
describe("seed hero specs", () => {
  const specs = heroSpecs();

  it("has unique booking slugs", () => {
    const slugs = specs.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("has unique teacher emails", () => {
    const emails = specs.map((s) => s.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("has unique student emails", () => {
    const emails = heroStudentEmails(specs);
    expect(new Set(emails).size).toBe(emails.length);
    // One per (hero, student-index).
    expect(emails.length).toBe(specs.reduce((n, s) => n + s.students.length, 0));
  });

  it("covers every plan and the key lifecycle states", () => {
    const plans = new Set(specs.map((s) => s.sub.plan));
    expect(plans).toEqual(new Set(["free", "monthly", "annual", "founding"]));

    const statuses = new Set(specs.map((s) => s.sub.status));
    for (const s of ["active", "trialing", "past_due", "canceled", "free"]) {
      expect(statuses.has(s as never)).toBe(true);
    }
  });

  it("includes both a Stripe-ready and a Wise-only teacher", () => {
    expect(specs.some((s) => s.stripeReady && !s.wiseOnly)).toBe(true);
    expect(specs.some((s) => s.wiseOnly && !s.stripeReady)).toBe(true);
  });

  // --- Rail coverage ------------------------------------------------------
  //
  // The seed's whole value on preview is that someone can exercise a rail
  // without hand-building a teacher. Until this block, it covered Stripe, Wise
  // and no-rail — and nothing else, which meant the bank rail, the multi-rail
  // chooser and the transfer discount were unreachable in every seeded
  // environment despite all three being live product.

  // A "covers the manual BANK rail" case lived here, asserting a hero who was
  // publicly listed because of a `bank_account` and nothing else — the only
  // fixture exercising that arm of HAS_PAYOUT_RAIL_WHERE. D-145 removed the
  // kind and the arm, so the hero and the case go with them.
  it("covers a teacher with every rail at once, so the method chooser renders", () => {
    // One rail renders no chooser at all, which is why a multi-rail hero is
    // the only way to reach the "Prefer to pay by bank transfer?" disclosure.
    // "Multi" is now card AND a transfer, not two transfers: D-145 left one
    // instrument kind, so a second rail can only come from Stripe.
    const multi = specs.filter((s) => s.stripeReady && (s.instruments?.length ?? 0) >= 1);
    expect(multi.length).toBeGreaterThan(0);
    const kinds = new Set(multi[0]!.instruments!.map((i) => i.kind));
    expect(kinds).toEqual(new Set(["wise"]));
  });

  it("never sets both wiseOnly and instruments on one hero", () => {
    // `wiseOnly` means EXACTLY ONE instrument — the Maestro Wise flow depends
    // on no method picker rendering. Combining the two would silently give
    // those heroes a second instrument and break that flow somewhere else.
    for (const spec of specs) {
      expect(
        spec.wiseOnly && spec.instruments?.length,
        `${spec.slug} sets both wiseOnly and instruments`,
      ).toBeFalsy();
    }
  });

  // A case here re-validated every seeded CLABE against the live registry, so
  // a seed could not create a row `saveTeacherInstrument` would have refused.
  // The registry and the kind are gone (D-145); a Wisetag is one regex, and
  // the heroes' handles are their own keys.
  it("covers pay-at-reservation, which needs the singleClass flag", () => {
    // classCount 1 is NOT the same question — see class-offering.ts. Only this
    // flag makes checkout demand a time before it takes money, and only with
    // it does the slot picker sit above the pay button.
    const all = specs.flatMap((s) => [s.template, ...(s.extraTemplates ?? [])]);
    expect(all.some((t) => t.singleClass === true)).toBe(true);
    // and a plain multi-class package still exists to contrast with
    expect(all.some((t) => !t.singleClass && t.classCount > 1)).toBe(true);
  });

  it("covers a transfer discount big enough for the UI to name", () => {
    // The "you save" line is suppressed under ~3%, so a 1-peso discount would
    // seed a saving nobody can see.
    const discounted = specs
      .flatMap((s) => [s.template, ...(s.extraTemplates ?? [])])
      .filter((t) => t.transferPriceMinorUnits != null);
    expect(discounted.length).toBeGreaterThan(0);
    for (const t of discounted) {
      expect(t.transferPriceMinorUnits!).toBeLessThan(t.priceMinorUnits);
      expect(t.transferPriceMinorUnits! / t.priceMinorUnits).toBeLessThan(0.97);
    }
  });

  it("covers a 0-decimal pricing currency", () => {
    // Every seeded price used to be MXN, so the currency-aware minor-unit
    // arithmetic was never exercised against a real row. A yen price divided
    // by 100 somewhere shows up as ¥50 instead of ¥5,000.
    const currencies = specs.map((s) => s.pricingCurrency).filter(Boolean) as string[];
    expect(currencies.some((c) => currencyExponent(c) === 0)).toBe(true);
  });

  it("covers a booking page sold in a language the teacher does not read", () => {
    // D-73's fourth language field. Nothing varied it, so the public funnel's
    // locale resolution was only ever exercised at its default.
    expect(specs.some((s) => s.bookingPageLocale != null)).toBe(true);
  });

  it("covers testimonials, which render on the landing page and in checkout", () => {
    expect(specs.some((s) => (s.testimonials?.length ?? 0) > 0)).toBe(true);
  });

  it("locks paid plans to their config price and leaves free unpriced", () => {
    expect(lockedPriceFor({ plan: "free", status: "free" })).toBeNull();
    expect(lockedPriceFor({ plan: "monthly", status: "active" })).toBe(
      PLAN_PRICE_MINOR_UNITS.monthly,
    );
    expect(lockedPriceFor({ plan: "annual", status: "active" })).toBe(
      PLAN_PRICE_MINOR_UNITS.annual,
    );
    expect(lockedPriceFor({ plan: "founding", status: "active" })).toBe(
      PLAN_PRICE_MINOR_UNITS.founding,
    );
  });

  it("over-provisions the Free teacher to exercise grandfathering", () => {
    const free = specs.find((s) => s.sub.plan === "free" && s.sub.status === "free");
    expect(free).toBeDefined();
    // Over FREE_MAX_ACTIVE_STUDENTS (3) and FREE_MAX_PACKAGE_TEMPLATES (1).
    expect(free!.students.length).toBeGreaterThan(3);
    expect(free!.extraTemplates?.length ?? 0).toBeGreaterThan(0);
  });
});
