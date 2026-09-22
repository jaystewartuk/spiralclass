import { describe, expect, it, vi } from "vitest";
import {
  NO_GRANDFATHERED_PRICES,
  effectivePriceMinorUnits,
  grandfatheredPricesFor,
} from "./grandfathered-prices";

/** A `db` stub exposing just the model this resolver touches. */
function fakeDb(rows: { templateId: string; priceMinorUnits: number }[]) {
  const findMany = vi.fn(async () => rows);
  return {
    db: { teacherStudentTemplatePrice: { findMany } } as unknown as Parameters<
      typeof grandfatheredPricesFor
    >[0],
    findMany,
  };
}

const tpl = (id: string, price: number, transfer: number | null = null) => ({
  id,
  priceMinorUnits: price,
  transferPriceMinorUnits: transfer,
});

describe("effectivePriceMinorUnits", () => {
  it("charges the catalog price when this student has no agreed price", () => {
    expect(effectivePriceMinorUnits(NO_GRANDFATHERED_PRICES, tpl("a", 185_000), "stripe")).toBe(
      185_000,
    );
  });

  it("lets an agreed price win over the catalog price", () => {
    const prices = new Map([["a", 130_000]]);
    expect(effectivePriceMinorUnits(prices, tpl("a", 185_000), "stripe")).toBe(130_000);
  });

  // THE regression this table exists for. The flat column it replaces held one
  // number for the whole pairing and applied it to whichever package the
  // student picked, so a student grandfathered on a 1,300 MXN 4-class package
  // was shown — and charged — 1,300 for the 8,000 MXN 20-class package.
  it("does not leak one package's agreed price onto another", () => {
    const prices = new Map([["four-class", 130_000]]);
    expect(effectivePriceMinorUnits(prices, tpl("twenty-class", 800_000), "stripe")).toBe(800_000);
  });

  it("beats the catalog price on the transfer rail too — there is no agreed transfer price", () => {
    const prices = new Map([["a", 130_000]]);
    expect(effectivePriceMinorUnits(prices, tpl("a", 185_000, 175_000), "manual_transfer")).toBe(
      130_000,
    );
  });

  it("still honours the rail split when there is no agreed price", () => {
    const t = tpl("a", 185_000, 175_000);
    expect(effectivePriceMinorUnits(NO_GRANDFATHERED_PRICES, t, "manual_transfer")).toBe(175_000);
    expect(effectivePriceMinorUnits(NO_GRANDFATHERED_PRICES, t, "stripe")).toBe(185_000);
  });

  it("honours an agreed price of zero rather than falling through to catalog", () => {
    const prices = new Map([["a", 0]]);
    expect(effectivePriceMinorUnits(prices, tpl("a", 185_000), "stripe")).toBe(0);
  });
});

// The legacy flat wire shape has one field and cannot render four.
describe("grandfatheredPricesFor", () => {
  it("keys the rows by template id", async () => {
    const { db } = fakeDb([
      { templateId: "a", priceMinorUnits: 130_000 },
      { templateId: "b", priceMinorUnits: 600_000 },
    ]);
    const prices = await grandfatheredPricesFor(db, "t1", "s1");
    expect(prices.get("a")).toBe(130_000);
    expect(prices.get("b")).toBe(600_000);
    expect(prices.get("c")).toBeUndefined();
  });

  it("scopes the read to the one pairing", async () => {
    const { db, findMany } = fakeDb([]);
    await grandfatheredPricesFor(db, "t1", "s1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teacherId: "t1", studentId: "s1" } }),
    );
  });

  it("returns an empty map when the student has no agreed price", async () => {
    const { db } = fakeDb([]);
    expect((await grandfatheredPricesFor(db, "t1", "s1")).size).toBe(0);
  });
});
