import {
  DEFAULT_PLATFORM_REGION,
  PLATFORM_REGIONS,
  type PlatformRegion,
} from "@spiralclass/shared";
import { allowStripeStub, serverEnv } from "@/lib/env";
import { fetchStripeClient, type StripeClient } from "./client";
import { createStubStripeClient } from "./stub";
import { logger } from "@/lib/logger";

const log = logger({ surface: "stripe" });

// Factory: real Stripe client when the region's secret key is set,
// otherwise a shared stub. The stub persists across calls (module-level,
// keyed by region) so a dev can create a checkout session and then replay
// a "webhook" against the same stub.
//
// In PRODUCTION the stub is never served: if creds are missing we throw.
// The stub mints fake `acct_*`/`cs_*` ids and a fake checkout URL, so
// returning it in prod would silently hand teachers/students unusable
// Stripe links and write bogus account ids. Failing closed is correct —
// Wise-only mode is a real, separate path (teachers without a connected
// Stripe account are never offered the Stripe rail), so this throw only
// fires if code reaches a Stripe call on a deploy that has no Stripe at
// all, which is a misconfiguration, not a degraded mode.
//
// The single exception is the E2E gate: it runs a NODE_ENV=production build
// (so hydration is fast + deterministic) but has no real Stripe, so it opts
// into the stub via E2E_STRIPE_STUB=1 (allowStripeStub()). That flag is never
// set in a real deploy, so production still fails closed.
//
// Tests construct their own stub directly via createStubStripeClient()
// rather than going through this factory.
//
// `region` selects which platform Stripe entity to talk to (PLATFORM_REGIONS
// in @spiralclass/shared). There is only one entry today (GB, the UK platform
// entity — D-58/D-99), so every caller resolves to the same client
// either way — the parameter exists so a future second region is additive
// instead of a rewrite.

const cache = new Map<PlatformRegion, StripeClient>();
const cacheKind = new Map<PlatformRegion, "stub" | "real">();

export class StripeNotConfiguredError extends Error {
  constructor() {
    super("Stripe is not configured (STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET missing)");
    this.name = "StripeNotConfiguredError";
  }
}

export function getStripeClient(region: PlatformRegion = DEFAULT_PLATFORM_REGION): StripeClient {
  const existing = cache.get(region);
  if (existing) return existing;

  const config = PLATFORM_REGIONS[region];
  const env = serverEnv();
  const secretKey = env[config.secretKeyEnv];
  const webhookSecret = env[config.webhookSecretEnv];

  let client: StripeClient;
  let kind: "stub" | "real";
  if (secretKey && webhookSecret) {
    client = fetchStripeClient({ secretKey });
    kind = "real";
  } else if (env.NODE_ENV === "production" && !allowStripeStub()) {
    // Fail closed — never serve the stub in prod (unless the E2E gate has
    // explicitly opted in via E2E_STRIPE_STUB, which a real deploy never sets).
    log.warn(
      `FATAL: ${config.secretKeyEnv}/${config.webhookSecretEnv} missing in production; refusing to serve the stub client.`,
    );
    throw new StripeNotConfiguredError();
  } else {
    client = createStubStripeClient();
    kind = "stub";
  }
  cache.set(region, client);
  cacheKind.set(region, kind);
  return client;
}

export function getStripeClientKind(
  region: PlatformRegion = DEFAULT_PLATFORM_REGION,
): "stub" | "real" | null {
  if (!cache.has(region)) getStripeClient(region);
  return cacheKind.get(region) ?? null;
}

// For tests that need a clean module state.
export function __resetStripeClient() {
  cache.clear();
  cacheKind.clear();
}

export type { StripeClient } from "./client";
export {
  StripeApiError,
  isStripeConnectNotEnabledError,
  isStripeAccountUnreachableError,
} from "./client";

export function isStripeNotConfiguredError(err: unknown): err is StripeNotConfiguredError {
  return err instanceof StripeNotConfiguredError;
}
