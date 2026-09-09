import { describe, expect, it } from "vitest";
import { hasCapability } from "@/lib/admin-capabilities";

// D-55: capability layer is additive to the rank ladder in lib/admin.ts.
// tester/engineer get uat:run; finance/support get nothing (by design —
// narrow tools aren't inherited via the money-adjacent rank); superadmin
// gets every capability.
describe("hasCapability", () => {
  it("grants uat:run to tester and engineer", () => {
    expect(hasCapability({ role: "tester" }, "uat:run")).toBe(true);
    expect(hasCapability({ role: "engineer" }, "uat:run")).toBe(true);
  });

  it("grants uat:run to superadmin", () => {
    expect(hasCapability({ role: "superadmin" }, "uat:run")).toBe(true);
  });

  it("does not grant uat:run to finance or support", () => {
    expect(hasCapability({ role: "finance" }, "uat:run")).toBe(false);
    expect(hasCapability({ role: "support" }, "uat:run")).toBe(false);
  });
});
