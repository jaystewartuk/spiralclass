import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPENSE_CATEGORY,
  EXPENSE_CATEGORIES,
  KNOWN_EXPENSE_VENDORS,
  isKnownExpenseVendor,
} from "./expenses-config";

// The platform-expense vendor/category registry drives the admin-costs create
// form (default category pre-select) and the mobile admin-costs routes. It's a
// hand-maintained list kept in sync with the Prisma ExpenseCategory enum, so
// the invariants worth locking are: every known vendor has a default category,
// that category is a real member of EXPENSE_CATEGORIES, and the guard actually
// narrows the string set.

describe("isKnownExpenseVendor", () => {
  it("accepts every vendor in the registry", () => {
    for (const vendor of KNOWN_EXPENSE_VENDORS) {
      expect(isKnownExpenseVendor(vendor)).toBe(true);
    }
  });

  it("rejects an unknown vendor string", () => {
    expect(isKnownExpenseVendor("stripe")).toBe(false);
    expect(isKnownExpenseVendor("")).toBe(false);
    expect(isKnownExpenseVendor("Vercel")).toBe(false); // case-sensitive
  });
});

describe("DEFAULT_EXPENSE_CATEGORY", () => {
  it("maps every known vendor to a default category", () => {
    for (const vendor of KNOWN_EXPENSE_VENDORS) {
      expect(DEFAULT_EXPENSE_CATEGORY[vendor]).toBeDefined();
    }
  });

  it("only ever maps to a real ExpenseCategory", () => {
    const categories = new Set<string>(EXPENSE_CATEGORIES);
    for (const vendor of KNOWN_EXPENSE_VENDORS) {
      expect(categories.has(DEFAULT_EXPENSE_CATEGORY[vendor])).toBe(true);
    }
  });

  it("has no default for a vendor outside the registry (exhaustive keys only)", () => {
    // The map is a Record over the exact vendor union — its key set must match
    // the vendor list, so a vendor added without a default is a compile error
    // and, here, a runtime mismatch guard.
    expect(Object.keys(DEFAULT_EXPENSE_CATEGORY).sort()).toEqual([...KNOWN_EXPENSE_VENDORS].sort());
  });

  it("classifies the AI vendors under the 'ai' category", () => {
    expect(DEFAULT_EXPENSE_CATEGORY.anthropic_api).toBe("ai");
    expect(DEFAULT_EXPENSE_CATEGORY.claude_code).toBe("ai");
    expect(DEFAULT_EXPENSE_CATEGORY.deepgram).toBe("ai");
  });

  it("routes the 'other' vendor to the 'other' category", () => {
    expect(DEFAULT_EXPENSE_CATEGORY.other).toBe("other");
  });
});

describe("registry integrity", () => {
  it("has no duplicate vendors", () => {
    expect(new Set(KNOWN_EXPENSE_VENDORS).size).toBe(KNOWN_EXPENSE_VENDORS.length);
  });

  it("has no duplicate categories", () => {
    expect(new Set(EXPENSE_CATEGORIES).size).toBe(EXPENSE_CATEGORIES.length);
  });
});
