import { describe, expect, it } from "vitest";
import {
  DEFAULT_TWO_PERSON_PRICE_PERCENT,
  isValidTwoPersonPricePercent,
  offersTwoPerson,
  parseSeats,
  perPersonPerClassMinorUnits,
  priceForSeats,
  suggestTwoPersonPrice,
} from "./two-person";

// The first real ladder this was built for: a 4-class package at 1,850 MXN
// sold for two at 2,775, with no separate transfer prices.
const fourPack = {
  priceMinorUnits: 185_000,
  transferPriceMinorUnits: null,
  twoPersonPriceMinorUnits: 277_500,
  twoPersonTransferPriceMinorUnits: null,
};

describe("parseSeats", () => {
  it("reads two people only from an exact two", () => {
    expect(parseSeats(2)).toBe(2);
    expect(parseSeats("2")).toBe(2);
  });

  it("falls back to one person for anything else, so garbage never makes a purchase dearer", () => {
    for (const value of [undefined, null, "", "1", 1, "3", 3, "two", 2.5]) {
      expect(parseSeats(value)).toBe(1);
    }
  });
});

describe("suggestTwoPersonPrice", () => {
  it("defaults to the second person paying half", () => {
    expect(suggestTwoPersonPrice(185_000, DEFAULT_TWO_PERSON_PRICE_PERCENT, "MXN")).toBe(277_500);
    expect(suggestTwoPersonPrice(350_000, DEFAULT_TWO_PERSON_PRICE_PERCENT, "MXN")).toBe(525_000);
  });

  it("rounds to a whole major unit of the teacher's own currency", () => {
    // 437.50 × 1.5 = 656.25 → 656
    expect(suggestTwoPersonPrice(43_750, 150, "MXN")).toBe(65_600);
    // JPY has no minor unit: 4,999 × 1.5 = 7,498.5 → 7,499, never ×100
    expect(suggestTwoPersonPrice(4_999, 150, "JPY")).toBe(7_499);
  });

  it("suggests nothing for a free package", () => {
    expect(suggestTwoPersonPrice(0, 150, "MXN")).toBe(0);
  });
});

describe("isValidTwoPersonPricePercent", () => {
  it("accepts whole percents from 100 to 300, the database CHECK's range", () => {
    expect(isValidTwoPersonPricePercent(100)).toBe(true);
    expect(isValidTwoPersonPricePercent(150)).toBe(true);
    expect(isValidTwoPersonPricePercent(300)).toBe(true);
  });

  it("refuses a percent that would make two people cheaper than one, a typo, or a fraction", () => {
    expect(isValidTwoPersonPricePercent(99)).toBe(false);
    expect(isValidTwoPersonPricePercent(301)).toBe(false);
    expect(isValidTwoPersonPricePercent(150.5)).toBe(false);
  });
});

describe("priceForSeats", () => {
  it("prices one person exactly as before, on both rails", () => {
    expect(priceForSeats(fourPack, 1, "stripe")).toBe(185_000);
    expect(priceForSeats(fourPack, 1, "manual_transfer")).toBe(185_000);
    expect(
      priceForSeats({ ...fourPack, transferPriceMinorUnits: 175_000 }, 1, "manual_transfer"),
    ).toBe(175_000);
  });

  it("prices two people from the two-person columns", () => {
    expect(priceForSeats(fourPack, 2, "stripe")).toBe(277_500);
    expect(
      priceForSeats(
        { ...fourPack, twoPersonTransferPriceMinorUnits: 262_000 },
        2,
        "manual_transfer",
      ),
    ).toBe(262_000);
  });

  it("never falls back across seat counts: two people by transfer cost the two-person price", () => {
    // The one-person transfer discount must not leak onto a package for two.
    const withSoloDiscount = { ...fourPack, transferPriceMinorUnits: 175_000 };
    expect(priceForSeats(withSoloDiscount, 2, "manual_transfer")).toBe(277_500);
  });

  it("has no price for two when the template is not sold for two", () => {
    const soloOnly = { ...fourPack, twoPersonPriceMinorUnits: null };
    expect(offersTwoPerson(soloOnly)).toBe(false);
    expect(priceForSeats(soloOnly, 2, "stripe")).toBeNull();
    expect(priceForSeats(soloOnly, 2, "manual_transfer")).toBeNull();
  });
});

describe("perPersonPerClassMinorUnits", () => {
  it("divides by classes and by people — the figure a couple compares", () => {
    // 2,775 for 4 classes for two = 346.88 each, each class
    expect(perPersonPerClassMinorUnits(277_500, 4, 2)).toBe(34_688);
    expect(perPersonPerClassMinorUnits(185_000, 4, 1)).toBe(46_250);
  });

  it("has nothing to say about a free or empty package", () => {
    expect(perPersonPerClassMinorUnits(0, 4, 2)).toBeNull();
    expect(perPersonPerClassMinorUnits(277_500, 0, 2)).toBeNull();
  });
});
