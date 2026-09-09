import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Perf follow-up #6: logger.debug used to serialize + emit unconditionally,
// even in production where nothing consumes it. debug is now a no-op there —
// skipping the JSON.stringify, not just discarding console output — while
// staying fully live in every other environment (dev, test, preview).

describe("logger debug gating", () => {
  const originalEnv = process.env.NODE_ENV;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (process.env as { NODE_ENV?: string }).NODE_ENV = originalEnv;
  });

  it("emits debug lines outside production", async () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "test";
    const { logger } = await import("@/lib/logger");
    logger({ surface: "x" }).debug("hello", { a: 1 });
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0][0]).toContain('"msg":"hello"');
  });

  it("is a no-op for debug in production", async () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    const { logger } = await import("@/lib/logger");
    logger({ surface: "x" }).debug("hello", { a: 1 });
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("still emits info/warn/error in production (only debug is gated)", async () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    const { logger } = await import("@/lib/logger");
    logger({ surface: "x" }).info("still here");
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});

// A non-Error thrown value used to log as the string "[object Object]".
//
// That is how a real Stripe failure on the public checkout reached production
// logs carrying nothing: the outage was visible, its cause was not. The same
// line also hid a caller passing FIELDS into the `err` slot — an easy slip,
// since `warn(message, fields)` and `error(message, err, fields)` differ in
// exactly that position, and it silently cost both the real error AND the
// context fields, plus gave Sentry a plain object with no stack to group on.
describe("logger — non-Error values stay readable", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  async function line(err: unknown): Promise<string> {
    const { logger } = await import("@/lib/logger");
    logger({ surface: "t" }).error("boom", err);
    return String(errorSpy.mock.calls[0]![0]);
  }

  it("pulls the useful fields off a thrown Stripe-shaped object", async () => {
    const out = await line({
      type: "StripeInvalidRequestError",
      code: "account_invalid",
      statusCode: 403,
      message: "does not have access to account",
    });

    expect(out).not.toContain("[object Object]");
    expect(out).toContain("account_invalid");
    expect(out).toContain("403");
  });

  it("serializes a plain object rather than flattening it", async () => {
    // The misplaced-fields case. It must be obvious what happened.
    const out = await line({ teacherId: "t1", externalReference: "ref-1" });

    expect(out).not.toContain("[object Object]");
    expect(out).toContain("teacherId");
    expect(out).toContain("ref-1");
  });

  it("truncates something huge instead of filling the log", async () => {
    const out = await line({ body: "x".repeat(5_000) });

    expect(out).not.toContain("[object Object]");
    expect(out.length).toBeLessThan(2_000);
  });

  it("still prefers a real Error's message", async () => {
    expect(await line(new Error("the actual failure"))).toContain("the actual failure");
  });

  it("leaves primitives alone", async () => {
    expect(await line("plain string")).toContain("plain string");
  });
});
