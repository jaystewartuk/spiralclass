import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Stripe client factory gate (lib/stripe/index.ts). This is a money-safety
// boundary: a real production deploy with no Stripe creds must FAIL CLOSED
// (throw) rather than silently serve the in-memory stub, which mints fake
// acct_/cs_ ids and unusable checkout URLs. The one sanctioned exception is the
// E2E gate, which runs a NODE_ENV=production build but opts into the stub via
// E2E_STRIPE_STUB=1 (allowStripeStub). These tests pin the full matrix so the
// guard can't regress in either direction.

const env = {
  allowStripeStub: vi.fn<() => boolean>(),
  serverEnv:
    vi.fn<() => { NODE_ENV: string; STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string }>(),
};

vi.mock("@/lib/env", () => ({
  allowStripeStub: () => env.allowStripeStub(),
  serverEnv: () => env.serverEnv(),
}));

vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const REAL = { __kind: "real" };
const STUB = { __kind: "stub" };
const fetchStripeClientMock = vi.fn(() => REAL);
vi.mock("@/lib/stripe/client", () => ({
  fetchStripeClient: () => fetchStripeClientMock(),
  StripeApiError: class StripeApiError extends Error {},
  isStripeConnectNotEnabledError: () => false,
}));
vi.mock("@/lib/stripe/stub", () => ({
  createStubStripeClient: vi.fn(() => STUB),
}));

import {
  __resetStripeClient,
  getStripeClient,
  getStripeClientKind,
  isStripeNotConfiguredError,
} from "@/lib/stripe";

function setEnv(opts: { hasCreds: boolean; nodeEnv: string; allowStub: boolean }) {
  env.allowStripeStub.mockReturnValue(opts.allowStub);
  env.serverEnv.mockReturnValue({
    NODE_ENV: opts.nodeEnv,
    STRIPE_SECRET_KEY: opts.hasCreds ? "sk_test_x" : undefined,
    STRIPE_WEBHOOK_SECRET: opts.hasCreds ? "whsec_test_x" : undefined,
  });
}

beforeEach(() => __resetStripeClient());
afterEach(() => vi.clearAllMocks());

describe("getStripeClient gating", () => {
  it("returns the real client when creds are present (any NODE_ENV)", () => {
    setEnv({ hasCreds: true, nodeEnv: "production", allowStub: false });
    expect(getStripeClient()).toBe(REAL);
    expect(getStripeClientKind()).toBe("real");
  });

  it("serves the stub in development when creds are missing", () => {
    setEnv({ hasCreds: false, nodeEnv: "development", allowStub: false });
    expect(getStripeClient()).toBe(STUB);
    expect(getStripeClientKind()).toBe("stub");
  });

  it("FAILS CLOSED in production when creds are missing and the stub is not allowed", () => {
    setEnv({ hasCreds: false, nodeEnv: "production", allowStub: false });
    let thrown: unknown;
    try {
      getStripeClient();
    } catch (e) {
      thrown = e;
    }
    expect(isStripeNotConfiguredError(thrown)).toBe(true);
  });

  it("serves the stub in a production build ONLY when E2E_STRIPE_STUB opts in", () => {
    setEnv({ hasCreds: false, nodeEnv: "production", allowStub: true });
    expect(getStripeClient()).toBe(STUB);
    expect(getStripeClientKind()).toBe("stub");
  });
});

describe("getStripeClient region resolution (multi-region prep)", () => {
  it("defaults to the GB region (the UK entity — D-58/D-99), resolving the existing env vars", () => {
    setEnv({ hasCreds: true, nodeEnv: "production", allowStub: false });
    expect(getStripeClient()).toBe(REAL);
  });

  it("an explicit GB region behaves identically to the default", () => {
    setEnv({ hasCreds: true, nodeEnv: "production", allowStub: false });
    expect(getStripeClient("GB")).toBe(REAL);
    expect(getStripeClientKind("GB")).toBe("real");
  });

  it("caches per region: two calls with the same region return the same instance", () => {
    setEnv({ hasCreds: true, nodeEnv: "production", allowStub: false });
    const first = getStripeClient("GB");
    const second = getStripeClient("GB");
    expect(first).toBe(second);
    expect(fetchStripeClientMock).toHaveBeenCalledTimes(1);
  });

  it("default-region calls and explicit-GB calls share the same cache entry", () => {
    setEnv({ hasCreds: true, nodeEnv: "production", allowStub: false });
    const byDefault = getStripeClient();
    const explicit = getStripeClient("GB");
    expect(byDefault).toBe(explicit);
    expect(fetchStripeClientMock).toHaveBeenCalledTimes(1);
  });
});
