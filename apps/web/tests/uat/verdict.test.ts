import { describe, expect, it } from "vitest";
import { computeCategoryBreakdown, computeVerdict } from "@/lib/uat/verdict";
import { UAT_SECTIONS, type UatCategory } from "@/lib/uat/runbook-steps";

describe("computeCategoryBreakdown", () => {
  it("only counts categories that are currently selected", () => {
    const breakdown = computeCategoryBreakdown(new Set<UatCategory>(["messaging"]), new Set());
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].category).toBe("messaging");
  });

  it("counts a category with zero items (e.g. setup's probe-only category 0) as total 0", () => {
    // "setup" includes category 0, which has no manual items at all — action-only.
    const breakdown = computeCategoryBreakdown(new Set<UatCategory>(["setup"]), new Set());
    const setup = breakdown.find((b) => b.category === "setup")!;
    const expectedTotal = UAT_SECTIONS.filter((s) => s.category === "setup").flatMap(
      (s) => s.items,
    ).length;
    expect(setup.total).toBe(expectedTotal);
  });

  it("counts done vs total from the checked-id set", () => {
    const messagingItems = UAT_SECTIONS.filter((s) => s.category === "messaging").flatMap(
      (s) => s.items,
    );
    const checked = new Set([messagingItems[0].id]);
    const breakdown = computeCategoryBreakdown(new Set<UatCategory>(["messaging"]), checked);
    expect(breakdown[0]).toEqual({ category: "messaging", done: 1, total: messagingItems.length });
  });
});

describe("computeVerdict", () => {
  it("is GO when every selected category is fully checked and nothing automated failed", () => {
    const breakdown = [{ category: "messaging" as UatCategory, done: 3, total: 3 }];
    expect(computeVerdict(breakdown, false)).toBe("GO");
  });

  it("is INCOMPLETE when a selected category has unchecked items (and nothing failed)", () => {
    const breakdown = [{ category: "messaging" as UatCategory, done: 2, total: 3 }];
    expect(computeVerdict(breakdown, false)).toBe("INCOMPLETE");
  });

  it("is NO_GO when an automated check failed, even if every category is fully checked", () => {
    const breakdown = [{ category: "messaging" as UatCategory, done: 3, total: 3 }];
    expect(computeVerdict(breakdown, true)).toBe("NO_GO");
  });

  it("NO_GO takes priority over INCOMPLETE", () => {
    const breakdown = [{ category: "messaging" as UatCategory, done: 1, total: 3 }];
    expect(computeVerdict(breakdown, true)).toBe("NO_GO");
  });

  it("a zero-item category (nothing to check) never makes the verdict INCOMPLETE", () => {
    const breakdown = [{ category: "setup" as UatCategory, done: 0, total: 0 }];
    expect(computeVerdict(breakdown, false)).toBe("GO");
  });

  it("is GO on an empty breakdown (no categories selected) with no failures", () => {
    expect(computeVerdict([], false)).toBe("GO");
  });
});
