import { describe, expect, it } from "vitest";

import { expectedFor, reconcile } from "../../../../scripts/readme-counts.mjs";

// D-180: the two counts nearly every pull request moves are stated as floors,
// so open branches stop conflicting on one line of README.md and testing.md.
// These pin the arithmetic and the one new failure mode — an exact count of a
// floored thing, which the floored pattern cannot see.

const TESTS = { id: "test files", pattern: /[Mm]ore than (\d[\d,]*) test files/g, floor: 100 };
const MODELS = { id: "Prisma models", pattern: /(\d[\d,]*) models/g };

describe("expectedFor", () => {
  it("is the count itself for an exact claim", () => {
    expect(expectedFor({}, 83)).toBe(83);
  });

  it("is the largest multiple of the step strictly below the count", () => {
    expect(expectedFor({ floor: 100 }, 803)).toBe(800);
    expect(expectedFor({ floor: 100 }, 899)).toBe(800);
    expect(expectedFor({ floor: 25 }, 127)).toBe(125);
  });

  it("never states a floor equal to the count, which would make 'more than' false", () => {
    expect(expectedFor({ floor: 100 }, 800)).toBe(700);
    expect(expectedFor({ floor: 100 }, 1)).toBe(0);
  });
});

describe("reconcile", () => {
  const docs = (text: string) => new Map([["README.md", text]]);

  it("leaves a floor alone for every count that does not cross a step", () => {
    for (const value of [801, 850, 900]) {
      const result = reconcile(docs("There are more than 800 test files."), [{ ...TESTS, value }]);
      expect(result.drift).toEqual([]);
    }
  });

  it("moves the floor when the count crosses a step, and --fix writes it", () => {
    const result = reconcile(docs("There are more than 800 test files."), [
      { ...TESTS, value: 901 },
    ]);
    expect(result.drift).toHaveLength(1);
    expect(result.next.get("README.md")).toBe("There are more than 900 test files.");
  });

  it("still holds an exact claim to the exact count", () => {
    const result = reconcile(docs("It has 82 models."), [{ ...MODELS, value: 83 }]);
    expect(result.drift).toHaveLength(1);
    expect(result.next.get("README.md")).toBe("It has 83 models.");
  });

  it("rejects an exact count of a floored claim, which nothing would check", () => {
    const result = reconcile(
      docs("There are more than 800 test files. Also 803 test files. More than 800 test files."),
      [{ ...TESTS, value: 803 }],
    );
    expect(result.unfloored).toHaveLength(1);
    expect(result.unfloored[0]).toContain('"803 test files"');
    expect(result.drift).toEqual([]);
  });

  it("reports a counted claim no document states", () => {
    const result = reconcile(docs("Nothing numeric here."), [{ ...TESTS, value: 803 }]);
    expect(result.unstated).toHaveLength(1);
  });
});
