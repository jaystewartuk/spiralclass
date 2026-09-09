import { headers } from "next/headers";
import * as Sentry from "@sentry/nextjs";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger({ surface: "rate-limit" });

// Rate limiter — pluggable backend.
//
// Default: in-memory token bucket. Survives between requests on the
// same lambda instance via module-level state; cold starts reset
// counts (which costs ~one allowance). Fine for the alpha-volume
// single-region deploy we run today.
//
// When both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
// are set, we route to Upstash Redis instead. The Upstash backend
// shares state across regions and survives cold starts, at the cost
// of one HTTP roundtrip per call. That is acceptable for the throttled
// endpoints (sign-in, sign-up, student magic-link) but should not be
// applied to hot paths.
//
// The public API is async regardless of which backend is active so
// callers don't need to know.

export interface RateLimitOptions {
  scope: string;
  // Max requests per window.
  limit: number;
  // Window length in ms.
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  retryAfterMs: number;
}

interface RateLimitBackend {
  consume(identifier: string, options: RateLimitOptions): Promise<RateLimitResult>;
  // Test affordance: reset all internal state. No-op on backends that
  // don't have local state to clear.
  reset(): void;
}

// ---------- In-memory backend ----------

interface Bucket {
  tokens: number;
  resetAt: number;
}

function createInMemoryBackend(): RateLimitBackend {
  const buckets = new Map<string, Bucket>();
  const MAX_BUCKETS = 10_000;

  return {
    async consume(identifier, options) {
      const now = Date.now();
      const key = `${options.scope}:${identifier}`;
      const existing = buckets.get(key);

      if (!existing || existing.resetAt <= now) {
        if (buckets.size >= MAX_BUCKETS) {
          // Crude eviction: drop the oldest entry by iteration order.
          // Good enough for an alpha-volume in-memory cache.
          const oldestKey = buckets.keys().next().value;
          if (oldestKey) buckets.delete(oldestKey);
        }
        buckets.set(key, {
          tokens: options.limit - 1,
          resetAt: now + options.windowMs,
        });
        return { ok: true, retryAfterMs: 0 };
      }

      if (existing.tokens <= 0) {
        return { ok: false, retryAfterMs: existing.resetAt - now };
      }

      existing.tokens -= 1;
      return { ok: true, retryAfterMs: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}

// ---------- Upstash backend ----------

// Hits Upstash's REST API with a 2-command pipeline:
//   INCR key
//   PEXPIRE key windowMs NX
// Reading the INCR result tells us the current count; the NX flag on
// PEXPIRE makes the TTL stick only on the first call of the window.
// If anything goes wrong (network, 5xx), we fail open with a Sentry
// breadcrumb — better to let one request through than to lock the
// whole surface when Redis is having a bad day.
function createUpstashBackend(url: string, token: string): RateLimitBackend {
  return {
    async consume(identifier, options) {
      const key = `rl:${options.scope}:${identifier}`;
      try {
        const res = await fetch(`${url}/pipeline`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify([
            ["INCR", key],
            ["PEXPIRE", key, String(options.windowMs), "NX"],
            ["PTTL", key],
          ]),
        });
        if (!res.ok) {
          return failOpen(options.scope, `upstash-http-${res.status}`);
        }
        const parsed = (await res.json()) as Array<{ result?: number }>;
        const count = parsed[0]?.result ?? 0;
        const ttl = parsed[2]?.result ?? options.windowMs;
        if (count > options.limit) {
          return { ok: false, retryAfterMs: Math.max(0, ttl) };
        }
        return { ok: true, retryAfterMs: 0 };
      } catch (err) {
        return failOpen(options.scope, err instanceof Error ? err.message : String(err));
      }
    },
    // Upstash state is shared; tests should use the in-memory backend.
    reset() {},
  };
}

// When Upstash is unreachable we deliberately let the request through (better
// to admit one request than to lock a whole surface when Redis has a bad day —
// see the backend doc above). But a *sustained* outage silently disables every
// rate limit, so each fail-open emits a warn-level log + a Sentry capture to
// make the degradation visible. The alert is throttled to at most once per
// window per scope so a hard outage doesn't flood Sentry with one event per
// request — the periodic heartbeat is enough to know it's ongoing.
const FAIL_OPEN_ALERT_THROTTLE_MS = 60_000;
const lastFailOpenAlertAt = new Map<string, number>();

function failOpen(scope: string, reason: string): RateLimitResult {
  const now = Date.now();
  const last = lastFailOpenAlertAt.get(scope) ?? 0;
  if (now - last >= FAIL_OPEN_ALERT_THROTTLE_MS) {
    lastFailOpenAlertAt.set(scope, now);
    log.warn("rate limiter failed open — Upstash unreachable, request admitted", {
      scope,
      reason,
    });
    Sentry.captureMessage("rate-limit fail-open (Upstash unreachable)", {
      level: "warning",
      tags: { surface: "rate-limit", scope },
      extra: { reason },
    });
  }
  return { ok: true, retryAfterMs: 0 };
}

// ---------- Backend selection ----------

let cachedBackend: RateLimitBackend | null = null;

function getBackend(): RateLimitBackend {
  if (cachedBackend) return cachedBackend;
  // Tests are detected via NODE_ENV — Vitest sets this to "test"
  // automatically. We always use in-memory for tests so they can
  // reset state deterministically.
  const env = trySafeEnv();
  if (
    env &&
    env.UPSTASH_REDIS_REST_URL &&
    env.UPSTASH_REDIS_REST_TOKEN &&
    env.NODE_ENV !== "test"
  ) {
    cachedBackend = createUpstashBackend(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
    return cachedBackend;
  }
  cachedBackend = createInMemoryBackend();
  return cachedBackend;
}

// `serverEnv()` throws if required envs are missing. Rate-limit calls
// happen from middleware-ish surfaces where a throw turns into a 500;
// guard so the limiter degrades to in-memory if the env parser can't
// load cleanly (e.g. during a partial deploy).
function trySafeEnv() {
  try {
    return serverEnv();
  } catch (err) {
    // Degrading to the in-memory limiter is intentional, but it must not be
    // silent — a persistently unparseable env means the distributed limiter is
    // off in production. Runs once per cold start (the backend is memoized).
    log.warn("env parse failed — rate limiter degrading to in-memory", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------- Per-scope configuration ----------

// Every limit and window is deployment configuration, not a source constant.
// A caller passes a working default so a fresh checkout runs unconfigured; the
// numbers a deployment actually enforces come from the environment and are set
// per environment alongside the other runtime config.
//
//   RATE_LIMIT_<SCOPE>              max requests per window
//   RATE_LIMIT_<SCOPE>_WINDOW_MS    window length in ms
//
// <SCOPE> is the call site's `scope`, upper-cased with `-` replaced by `_`
// (scope "sign-in-email" reads `RATE_LIMIT_SIGN_IN_EMAIL`). A blank, absent or
// unparseable value falls back to what the caller passed, so a typo degrades to
// the default rather than removing the limit.
function envKeyFor(scope: string): string {
  return scope.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function resolveRateLimitOptions(options: RateLimitOptions): RateLimitOptions {
  const key = envKeyFor(options.scope);
  return {
    scope: options.scope,
    limit: envPositiveInt(`RATE_LIMIT_${key}`) ?? options.limit,
    windowMs: envPositiveInt(`RATE_LIMIT_${key}_WINDOW_MS`) ?? options.windowMs,
  };
}

// Public surface — async, backend-agnostic.
export async function rateLimit(
  identifier: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  return getBackend().consume(identifier, resolveRateLimitOptions(options));
}

// Best-effort client IP for rate-limit keying. Falls back to a single
// "unknown" bucket — slightly stricter for the no-IP case is intentional.
export async function clientIp(): Promise<string> {
  const h = await headers();
  return pickClientIp({
    flyClientIp: h.get("fly-client-ip"),
    realIp: h.get("x-real-ip"),
    xff: h.get("x-forwarded-for"),
  });
}

// Same extraction for plain `Request` handlers, which have the request in hand
// rather than the ambient next/headers ctx.
export function clientIpFromRequest(req: Request): string {
  return pickClientIp({
    flyClientIp: req.headers.get("fly-client-ip"),
    realIp: req.headers.get("x-real-ip"),
    xff: req.headers.get("x-forwarded-for"),
  });
}

// SECURITY (audit M-1): prefer platform-set, single-value headers that a client
// cannot forge — `fly-client-ip` (Fly's edge-observed peer) and `x-real-ip`
// (Vercel sets it to the real client). The left-most `x-forwarded-for` entry is
// CLIENT-CONTROLLED: a caller can prepend arbitrary IPs, and the platform only
// APPENDS the real one, so keying rate limits off `xff[0]` lets an attacker mint
// a fresh bucket per request and bypass the limit. `x-forwarded-for` is used
// only as a last resort when no trusted header is present (e.g. a bare local
// proxy in dev). Never widen this to trust arbitrary XFF positions.
function pickClientIp(headers: {
  flyClientIp: string | null;
  realIp: string | null;
  xff: string | null;
}): string {
  const trusted = (headers.flyClientIp ?? headers.realIp ?? "").trim();
  if (trusted) return trusted;
  if (headers.xff) {
    const first = headers.xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

// Test-only: reset the in-memory backend. Tests import directly.
export function __resetBucketsForTests(): void {
  getBackend().reset();
}
