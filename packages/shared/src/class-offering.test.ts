import { describe, expect, it } from "vitest";
import {
  isOneClassOffering,
  isOneClassSoldAsCredit,
  reservesSlotAtPurchase,
} from "./class-offering";

// The whole point of these two predicates is that they DISAGREE on one input.
// If a future change makes them agree everywhere, one of them is redundant and
// the distinction has been quietly lost — so the divergent case is pinned
// hardest.

const individualClass = { singleClass: true, classCount: 1 };
const oneClassCredit = { singleClass: false, classCount: 1 };
const fourClassPackage = { singleClass: false, classCount: 4 };

describe("isOneClassOffering — is this one class?", () => {
  it("is true for a template sold explicitly as an individual class", () => {
    expect(isOneClassOffering(individualClass)).toBe(true);
  });

  it("is true for one class sold as a credit, because one class is one class", () => {
    // The per-class rate of a single credit IS the single-class rate; excluding
    // it would let it compete for "best value" against itself.
    expect(isOneClassOffering(oneClassCredit)).toBe(true);
  });

  it("is false for a real multi-class package", () => {
    expect(isOneClassOffering(fourClassPackage)).toBe(false);
  });
});

describe("reservesSlotAtPurchase — does paying book the time?", () => {
  it("is true only when the teacher ticked the box", () => {
    expect(reservesSlotAtPurchase(individualClass)).toBe(true);
  });

  it("is FALSE for a one-class credit, which is the whole distinction", () => {
    // Inferring it from classCount would make the template unbuyable whenever
    // the availability window is empty — a cost the teacher must opt into.
    expect(reservesSlotAtPurchase(oneClassCredit)).toBe(false);
  });

  it("is false for a multi-class package", () => {
    expect(reservesSlotAtPurchase(fourClassPackage)).toBe(false);
  });
});

describe("the two questions", () => {
  it("disagree on exactly one shape: one class sold as a credit", () => {
    const shapes = [individualClass, oneClassCredit, fourClassPackage];
    const divergent = shapes.filter((s) => isOneClassOffering(s) !== reservesSlotAtPurchase(s));
    expect(divergent).toEqual([oneClassCredit]);
  });

  it("names that shape, for the form to explain it", () => {
    expect(isOneClassSoldAsCredit(oneClassCredit)).toBe(true);
    expect(isOneClassSoldAsCredit(individualClass)).toBe(false);
    expect(isOneClassSoldAsCredit(fourClassPackage)).toBe(false);
  });

  it("treats a zero-class template as neither, rather than crashing", () => {
    // Not reachable through the form, but the predicates are handed rows from
    // the database and must not assert.
    const empty = { singleClass: false, classCount: 0 };
    expect(isOneClassOffering(empty)).toBe(false);
    expect(reservesSlotAtPurchase(empty)).toBe(false);
  });
});
