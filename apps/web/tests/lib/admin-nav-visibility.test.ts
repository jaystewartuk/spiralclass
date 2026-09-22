import { describe, expect, it } from "vitest";
import { canSee, type NavItem } from "@/lib/admin-nav-visibility";

// D-55: tester/engineer rank BELOW every existing tier (support/finance/
// superadmin) so they see nothing via rank — only a capability-gated item
// should be visible to them. This is what makes them "narrow" roles rather
// than a new rung on the money-adjacent ladder.
const rankOnlyItem: NavItem = {
  href: "/admin/payments",
  label: "Payments",
  minRole: "finance",
  section: "money",
};
const capabilityItem: NavItem = {
  href: "/admin/uat",
  label: "UAT tools",
  minRole: "superadmin",
  capability: "uat:run",
  section: "admin",
};

describe("canSee", () => {
  it("existing rank-only items are unaffected by the capability layer", () => {
    expect(canSee({ role: "superadmin" }, rankOnlyItem)).toBe(true);
    expect(canSee({ role: "finance" }, rankOnlyItem)).toBe(true);
    expect(canSee({ role: "support" }, rankOnlyItem)).toBe(false);
  });

  it("tester/engineer cannot see a rank-only item", () => {
    expect(canSee({ role: "tester" }, rankOnlyItem)).toBe(false);
    expect(canSee({ role: "engineer" }, rankOnlyItem)).toBe(false);
  });

  it("tester/engineer CAN see a capability-gated item via their capability, not rank", () => {
    expect(canSee({ role: "tester" }, capabilityItem)).toBe(true);
    expect(canSee({ role: "engineer" }, capabilityItem)).toBe(true);
  });

  it("finance/support cannot see a capability-gated item they weren't granted", () => {
    expect(canSee({ role: "finance" }, capabilityItem)).toBe(false);
    expect(canSee({ role: "support" }, capabilityItem)).toBe(false);
  });

  it("superadmin sees a capability-gated item via rank alone", () => {
    expect(canSee({ role: "superadmin" }, capabilityItem)).toBe(true);
  });
});
