import { beforeEach, describe, expect, it, vi } from "vitest";

// Per-session admin MFA step-up proof (security audit H-1). The proof is an
// HMAC-signed, expiring value bound to the auth user id, kept independent of
// the better-auth session cookie so session presence alone can't mint it.

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ SESSION_SECRET: "test-session-secret-abcdefghijklmnop" }),
  isProductionDeployment: () => false,
}));

// next/headers cookies() is unused by the pure functions under test.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const { mintStepUpValue, isStepUpValueValid, ADMIN_STEPUP_TTL_MS } =
  await import("@/lib/auth/admin-stepup");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const NOW = 1_760_000_000_000;

beforeEach(() => vi.clearAllMocks());

describe("admin step-up proof", () => {
  it("accepts a freshly minted proof for the same user within its TTL", () => {
    const value = mintStepUpValue(USER_A, NOW);
    expect(isStepUpValueValid(value, USER_A, NOW + 1000)).toBe(true);
  });

  it("rejects a proof once its TTL has elapsed", () => {
    const value = mintStepUpValue(USER_A, NOW);
    expect(isStepUpValueValid(value, USER_A, NOW + ADMIN_STEPUP_TTL_MS + 1)).toBe(false);
  });

  it("rejects a proof minted for a different user (no cross-account replay)", () => {
    const value = mintStepUpValue(USER_A, NOW);
    expect(isStepUpValueValid(value, USER_B, NOW + 1000)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const value = mintStepUpValue(USER_A, NOW);
    const tampered = value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
    expect(isStepUpValueValid(tampered, USER_A, NOW + 1000)).toBe(false);
  });

  it("rejects a proof whose expiry was extended without re-signing", () => {
    const value = mintStepUpValue(USER_A, NOW);
    const sig = value.slice(value.indexOf(".") + 1);
    const forged = `${NOW + ADMIN_STEPUP_TTL_MS * 10}.${sig}`;
    expect(isStepUpValueValid(forged, USER_A, NOW + 1000)).toBe(false);
  });

  it("rejects undefined / malformed values", () => {
    expect(isStepUpValueValid(undefined, USER_A, NOW)).toBe(false);
    expect(isStepUpValueValid("", USER_A, NOW)).toBe(false);
    expect(isStepUpValueValid("no-dot", USER_A, NOW)).toBe(false);
    expect(isStepUpValueValid(".sigonly", USER_A, NOW)).toBe(false);
    expect(isStepUpValueValid("notanumber.sig", USER_A, NOW)).toBe(false);
  });
});
