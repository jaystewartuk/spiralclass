import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetBucketsForTests, rateLimit, resolveRateLimitOptions } from "@/lib/rate-limit";

describe("rateLimit", () => {
  afterEach(() => {
    __resetBucketsForTests();
  });

  it("allows up to `limit` requests in a window", async () => {
    const opts = { scope: "test", limit: 3, windowMs: 60_000 };
    expect((await rateLimit("ip-1", opts)).ok).toBe(true);
    expect((await rateLimit("ip-1", opts)).ok).toBe(true);
    expect((await rateLimit("ip-1", opts)).ok).toBe(true);
    const fourth = await rateLimit("ip-1", opts);
    expect(fourth.ok).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("isolates identifiers", async () => {
    const opts = { scope: "test", limit: 1, windowMs: 60_000 };
    expect((await rateLimit("ip-A", opts)).ok).toBe(true);
    expect((await rateLimit("ip-A", opts)).ok).toBe(false);
    expect((await rateLimit("ip-B", opts)).ok).toBe(true);
  });

  it("isolates scopes", async () => {
    expect((await rateLimit("ip-1", { scope: "sign-in", limit: 1, windowMs: 60_000 })).ok).toBe(
      true,
    );
    expect((await rateLimit("ip-1", { scope: "sign-in", limit: 1, windowMs: 60_000 })).ok).toBe(
      false,
    );
    expect((await rateLimit("ip-1", { scope: "sign-up", limit: 1, windowMs: 60_000 })).ok).toBe(
      true,
    );
  });

  it("re-fills after the window elapses", async () => {
    const opts = { scope: "test", limit: 1, windowMs: 10 };
    expect((await rateLimit("ip-1", opts)).ok).toBe(true);
    expect((await rateLimit("ip-1", opts)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 15));
    expect((await rateLimit("ip-1", opts)).ok).toBe(true);
  });
});

// The limit and window a deployment enforces are configuration, not source
// constants: `RATE_LIMIT_<SCOPE>` / `RATE_LIMIT_<SCOPE>_WINDOW_MS` override
// what the call site passes. The call site's value is a working default so a
// fresh checkout runs unconfigured — which is exactly why a malformed override
// has to fall back to it rather than removing the limit.
describe("resolveRateLimitOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetBucketsForTests();
  });

  const opts = { scope: "sign-in-email", limit: 4, windowMs: 5 * 60_000 };

  it("falls back to the caller's values when nothing is set", () => {
    expect(resolveRateLimitOptions(opts)).toEqual(opts);
  });

  it("derives the env key from the scope, upper-cased with separators mapped", () => {
    vi.stubEnv("RATE_LIMIT_SIGN_IN_EMAIL", "11");
    vi.stubEnv("RATE_LIMIT_SIGN_IN_EMAIL_WINDOW_MS", "90000");
    expect(resolveRateLimitOptions(opts)).toEqual({
      scope: "sign-in-email",
      limit: 11,
      windowMs: 90_000,
    });
  });

  it("overrides the limit and the window independently", () => {
    vi.stubEnv("RATE_LIMIT_SIGN_IN_EMAIL", "11");
    expect(resolveRateLimitOptions(opts)).toEqual({ ...opts, limit: 11 });
  });

  it("never lets a malformed value remove the limit", () => {
    // Blank, whitespace, non-numeric, zero, negative and fractional all mean
    // "somebody typo'd the config", and the safe reading of a typo is the
    // default — never an unbounded or zero budget.
    for (const bad of ["", "   ", "lots", "0", "-5", "2.5", "NaN", "Infinity"]) {
      vi.stubEnv("RATE_LIMIT_SIGN_IN_EMAIL", bad);
      expect(resolveRateLimitOptions(opts), `RATE_LIMIT_SIGN_IN_EMAIL=${bad}`).toEqual(opts);
    }
  });

  it("is applied by rateLimit itself, so no call site has to read the env", async () => {
    vi.stubEnv("RATE_LIMIT_ENV_APPLIED", "1");
    const passed = { scope: "env-applied", limit: 50, windowMs: 60_000 };
    expect((await rateLimit("ip-1", passed)).ok).toBe(true);
    // The env budget of 1 is spent, not the 50 the call site passed.
    expect((await rateLimit("ip-1", passed)).ok).toBe(false);
  });
});
