import { afterEach, describe, expect, it, vi } from "vitest";

// VAT/GST kill-switch (global-launch item 7). Capture-only by default: tax
// computation is off unless STRIPE_TAX_ENABLED is explicitly "1"/"true".

const state = { STRIPE_TAX_ENABLED: undefined as string | undefined };

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ STRIPE_TAX_ENABLED: state.STRIPE_TAX_ENABLED }),
}));

const { stripeTaxEnabled } = await import("@/lib/stripe/tax");

afterEach(() => {
  state.STRIPE_TAX_ENABLED = undefined;
});

describe("stripeTaxEnabled", () => {
  it("defaults OFF when the flag is unset (capture-only)", () => {
    expect(stripeTaxEnabled()).toBe(false);
  });

  it('is ON only for "1" or "true"', () => {
    state.STRIPE_TAX_ENABLED = "1";
    expect(stripeTaxEnabled()).toBe(true);
    state.STRIPE_TAX_ENABLED = "true";
    expect(stripeTaxEnabled()).toBe(true);
  });

  it("stays OFF for any other truthy-looking value", () => {
    for (const v of ["yes", "on", "0", "false", ""]) {
      state.STRIPE_TAX_ENABLED = v;
      expect(stripeTaxEnabled()).toBe(false);
    }
  });
});
