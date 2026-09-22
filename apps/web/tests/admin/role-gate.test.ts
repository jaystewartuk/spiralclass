import { describe, it, expect } from "vitest";
import { isBootstrapActor, meetsRole, BOOTSTRAP_ACTOR_ID } from "@/lib/admin";

describe("meetsRole hierarchy", () => {
  it("superadmin satisfies every required role", () => {
    const actor = { role: "superadmin" as const };
    expect(meetsRole(actor, "superadmin")).toBe(true);
    expect(meetsRole(actor, "finance")).toBe(true);
    expect(meetsRole(actor, "support")).toBe(true);
  });

  it("finance satisfies finance and support but not superadmin", () => {
    const actor = { role: "finance" as const };
    expect(meetsRole(actor, "superadmin")).toBe(false);
    expect(meetsRole(actor, "finance")).toBe(true);
    expect(meetsRole(actor, "support")).toBe(true);
  });

  it("support satisfies only support", () => {
    const actor = { role: "support" as const };
    expect(meetsRole(actor, "superadmin")).toBe(false);
    expect(meetsRole(actor, "finance")).toBe(false);
    expect(meetsRole(actor, "support")).toBe(true);
  });
});

describe("isBootstrapActor", () => {
  it("detects the sentinel id used during env-allowlist bootstrap", () => {
    expect(isBootstrapActor({ id: BOOTSTRAP_ACTOR_ID })).toBe(true);
  });

  it("returns false for any real uuid", () => {
    expect(isBootstrapActor({ id: "11111111-1111-4111-8111-111111111111" })).toBe(false);
  });
});
