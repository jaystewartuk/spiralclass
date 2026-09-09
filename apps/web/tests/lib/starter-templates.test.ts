import { describe, expect, it } from "vitest";
import { availabilitySchema } from "@/lib/validators";
import { DEFAULT_LOCALE } from "@spiralclass/shared";
import {
  STARTER_AVAILABILITY,
  starterAvailabilityFor,
  starterTemplatesFor,
} from "@/lib/starter-templates";

// Package templates / P2 starter templates: auto-created on first authenticated
// teacher request. The exact prices, class counts, and (now catalog-backed)
// names are user-facing copy; this test makes the values version-controlled
// so a typo at signup time can't ship silently, and pins the requirement
// that seeded names come from the i18n catalog in the teacher's locale
// rather than a hardcoded English literal.

describe("starterTemplatesFor", () => {
  // The regression this pins: the default was es-MX, on the reasoning that
  // teacher-facing copy defaults to the launch market's language. Teachers are
  // anywhere and speak anything, so a signup whose Accept-Language resolves to
  // nothing was handed Spanish package names it could not read. The fallback
  // is now the platform default, like every other piece of copy with no
  // better signal.
  it("defaults to the platform locale, not the launch market's", () => {
    expect(starterTemplatesFor()).toEqual(starterTemplatesFor(DEFAULT_LOCALE));
    expect(starterTemplatesFor()).not.toEqual(starterTemplatesFor("es-MX"));
  });

  it("contains exactly the four starter packages by default", () => {
    const templates = starterTemplatesFor();
    expect(templates).toHaveLength(4);
    expect(templates.map((t) => t.name)).toEqual([
      "4 classes / 1 month",
      "8 classes / 2 months",
      "12 classes / 3 months",
      "20 classes / 5 months",
    ]);
  });

  it("still localizes names to Spanish when given locale 'es-MX'", () => {
    expect(starterTemplatesFor("es-MX").map((t) => t.name)).toEqual([
      "4 clases / 1 mes",
      "8 clases / 2 meses",
      "12 clases / 3 meses",
      "20 clases / 5 meses",
    ]);
  });

  it("localizes names to English when given locale 'en', without changing the amounts", () => {
    const templates = starterTemplatesFor("en");
    expect(templates.map((t) => t.name)).toEqual([
      "4 classes / 1 month",
      "8 classes / 2 months",
      "12 classes / 3 months",
      "20 classes / 5 months",
    ]);
    expect(templates.map(({ name: _name, ...rest }) => rest)).toEqual(
      starterTemplatesFor("es-MX").map(({ name: _name, ...rest }) => rest),
    );
  });

  it("localizes names to French when given locale 'fr'", () => {
    const templates = starterTemplatesFor("fr");
    expect(templates.map((t) => t.name)).toEqual([
      "4 cours / 1 mois",
      "8 cours / 2 mois",
      "12 cours / 3 mois",
      "20 cours / 5 mois",
    ]);
  });

  it("'4 classes / 1 month' is 4 classes, $1,200 MXN, 1-month expiration", () => {
    const t = starterTemplatesFor("en").find((x) => x.name === "4 classes / 1 month")!;
    expect(t).toMatchObject({
      classCount: 4,
      priceMinorUnits: 120_000,
      expirationMonths: 1,
    });
  });

  it("'8 classes / 2 months' is 8 classes, $2,200 MXN, 2-month expiration", () => {
    const t = starterTemplatesFor("en").find((x) => x.name === "8 classes / 2 months")!;
    expect(t).toMatchObject({
      classCount: 8,
      priceMinorUnits: 220_000,
      expirationMonths: 2,
    });
  });

  it("'12 classes / 3 months' is 12 classes, $3,000 MXN, 3-month expiration", () => {
    const t = starterTemplatesFor("en").find((x) => x.name === "12 classes / 3 months")!;
    expect(t).toMatchObject({
      classCount: 12,
      priceMinorUnits: 300_000,
      expirationMonths: 3,
    });
  });

  it("'20 classes / 5 months' is 20 classes, $4,800 MXN, 5-month expiration", () => {
    const t = starterTemplatesFor("en").find((x) => x.name === "20 classes / 5 months")!;
    expect(t).toMatchObject({
      classCount: 20,
      priceMinorUnits: 480_000,
      expirationMonths: 5,
    });
  });

  it("every starter template carries a positive expiration (package templates invariant)", () => {
    for (const t of starterTemplatesFor()) {
      expect(t.expirationMonths).toBeGreaterThan(0);
    }
  });

  it("all prices are non-negative integer minor units (tenant isolation invariant)", () => {
    for (const t of starterTemplatesFor()) {
      expect(Number.isInteger(t.priceMinorUnits)).toBe(true);
      expect(t.priceMinorUnits).toBeGreaterThanOrEqual(0);
    }
  });
});

// Seeded at signup so a teacher who skips the onboarding availability step
// still has a bookable link. The rows must satisfy the same schema the form
// submits through, or the seed would produce a state the editor rejects.
describe("STARTER_AVAILABILITY", () => {
  it("seeds a normal working week — Mon–Fri 09:00–17:00", () => {
    expect(STARTER_AVAILABILITY).toEqual([
      { weekday: 1, startTime: "09:00", endTime: "17:00" },
      { weekday: 2, startTime: "09:00", endTime: "17:00" },
      { weekday: 3, startTime: "09:00", endTime: "17:00" },
      { weekday: 4, startTime: "09:00", endTime: "17:00" },
      { weekday: 5, startTime: "09:00", endTime: "17:00" },
    ]);
  });

  it("is a valid, non-empty schedule the availability schema accepts", () => {
    const parsed = availabilitySchema().safeParse({
      bufferMin: 0,
      minAdvanceH: 0,
      maxAdvanceDays: 30,
      ranges: STARTER_AVAILABILITY,
    });
    expect(parsed.success).toBe(true);
    expect(STARTER_AVAILABILITY.length).toBeGreaterThan(0);
  });
});

// D-53: seeded rows must carry the teacher's zone so the frozen wall clock is
// unambiguous from the very first booking, not just after the teacher re-saves.
describe("starterAvailabilityFor", () => {
  it("stamps every seeded rule with the given zone, preserving the base schedule", () => {
    const rows = starterAvailabilityFor("Europe/Madrid");
    expect(rows).toHaveLength(STARTER_AVAILABILITY.length);
    for (const row of rows) {
      expect(row.timezone).toBe("Europe/Madrid");
    }
    // Same weekdays/times as the naive base, just with the zone added.
    expect(
      rows.map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime })),
    ).toEqual(STARTER_AVAILABILITY);
  });
});
