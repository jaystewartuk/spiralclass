import { describe, expect, it } from "vitest";

/**
 * The "best value" mark on the booking page's package list (Phase 4).
 *
 * The list was flat — identical rows, ordered by price — so position alone
 * made the cheapest package the implied answer. The mark introduces a
 * hierarchy, and the whole risk of a hierarchy is that it asserts something
 * untrue. These tests pin the two ways it could: marking a package that is not
 * actually better value, and marking one whose advantage is rounding.
 *
 * The rule is duplicated here rather than imported because it lives inline in
 * the page's server component; if it moves to a module, point this at it.
 */
type Pkg = { id: string; priceMinorUnits: number; classCount: number; singleClass: boolean };

function bestValueId(packages: Pkg[]): string | null {
  const perClass = (p: Pkg) => (p.classCount > 0 ? p.priceMinorUnits / p.classCount : Infinity);
  const multi = packages.filter((p) => !p.singleClass && p.classCount > 1);
  const singleRate = Math.min(
    ...packages.filter((p) => p.singleClass || p.classCount === 1).map(perClass),
    Infinity,
  );
  const best =
    multi.length > 0 ? multi.reduce((a, b) => (perClass(b) < perClass(a) ? b : a)) : null;
  return best && Number.isFinite(singleRate) && perClass(best) <= singleRate * 0.97
    ? best.id
    : null;
}

const single = (id: string, price: number): Pkg => ({
  id,
  priceMinorUnits: price,
  classCount: 1,
  singleClass: true,
});
const bundle = (id: string, price: number, count: number): Pkg => ({
  id,
  priceMinorUnits: price,
  classCount: count,
  singleClass: false,
});

describe("booking page — best-value mark", () => {
  it("marks the lowest price per class, not the lowest price", () => {
    // The distinction the mark exists for: the 4-pack is cheaper outright,
    // the 10-pack is better value, and a flat list pointed at the wrong one.
    const id = bestValueId([
      single("s", 30000),
      bundle("four", 100000, 4),
      bundle("ten", 220000, 10),
    ]);
    expect(id).toBe("ten");
  });

  it("marks nothing when packages are priced linearly", () => {
    // No bundle beats the single-class rate, so there is no better value and
    // claiming one would be a lie a student can check with a calculator.
    expect(bestValueId([single("s", 25000), bundle("four", 100000, 4)])).toBeNull();
  });

  it("marks nothing when the advantage is under three percent", () => {
    // 2% off is rounding, not an offer.
    expect(bestValueId([single("s", 25000), bundle("four", 98000, 4)])).toBeNull();
  });

  it("marks a genuine discount at exactly the threshold", () => {
    expect(bestValueId([single("s", 25000), bundle("four", 97000, 4)])).toBe("four");
  });

  it("marks nothing when there is no single-class package to compare against", () => {
    // Without a baseline rate there is nothing to be better value THAN.
    expect(bestValueId([bundle("four", 100000, 4), bundle("ten", 220000, 10)])).toBeNull();
  });

  it("never marks a single-class package", () => {
    expect(bestValueId([single("cheap", 1000), bundle("ten", 220000, 10)])).not.toBe("cheap");
  });

  it("survives a zero class count rather than dividing by it", () => {
    // Defensive: a malformed template must not make the whole page throw.
    expect(() =>
      bestValueId([single("s", 25000), { ...bundle("bad", 5000, 0), classCount: 0 }]),
    ).not.toThrow();
  });
});
