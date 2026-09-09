import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { REFERRAL_COOKIE } from "@/lib/subscriptions/referral";
import { MAINTENANCE_BYPASS_COOKIE } from "@/lib/maintenance";

// updateSession is the whole substance of src/middleware.ts (a 3-line delegator).
// It runs on every request and is load-bearing for three things the rest of the
// app trusts: the per-request CSP header + nonce, the auth-gate redirects for
// teacher/student/admin paths, and the ?ref= ambassador-attribution cookie that
// lib/auth.ts later reads at lazy teacher-create.
//
// Optimistic/edge-safe per the D-40 migration plan: only a session-cookie
// PRESENCE check (getSessionCookie) gates protected paths — no DB round trip.
// The superuser destination on the /sign-in bounce reads the signed
// cookie-cache (getCookieCache) best-effort; a cache miss just falls back to
// /dashboard rather than blocking anything.

const getSessionCookie = vi.fn();
const getCookieCache = vi.fn();
vi.mock("better-auth/cookies", () => ({
  getSessionCookie: (req: unknown) => getSessionCookie(req),
  getCookieCache: (req: unknown, config: unknown) => getCookieCache(req, config),
}));

const isSuperuser = vi.fn((_email?: string | null) => false);
const envState = {
  betterAuthSecret: "test-secret" as string | undefined,
  appUrl: "https://preview.spiralclass.com",
};
vi.mock("@/lib/env", () => ({
  isSuperuser: (email: string | null | undefined) => isSuperuser(email),
  serverEnv: () => ({
    BETTER_AUTH_SECRET: envState.betterAuthSecret,
    APP_URL: envState.appUrl,
  }),
}));

const { updateSession } = await import("@/lib/auth/middleware");

function reqFor(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  isSuperuser.mockReturnValue(false);
  getSessionCookie.mockReturnValue(null);
  getCookieCache.mockResolvedValue(null);
  envState.betterAuthSecret = "test-secret";
  envState.appUrl = "https://preview.spiralclass.com";
  // Pin CSP to its advisory (report-only) default so the header-name
  // assertions below are deterministic regardless of ambient NODE_ENV.
  vi.stubEnv("CSP_ENFORCE", "0");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("updateSession — CSP", () => {
  it("stamps a report-only CSP header carrying a per-request nonce by default", async () => {
    const res = await updateSession(reqFor("/"));
    const csp = res.headers.get("Content-Security-Policy-Report-Only");
    expect(csp).toBeTruthy();
    expect(csp).toContain("nonce-");
    // Default mode is advisory — it must NOT ship the enforcing header.
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});

describe("updateSession — auth gate redirects", () => {
  it("redirects an unauthenticated teacher path to /sign-in with a next param", async () => {
    getSessionCookie.mockReturnValue(null);
    const res = await updateSession(reqFor("/dashboard/classes"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/sign-in");
    expect(loc.searchParams.get("next")).toBe("/dashboard/classes");
  });

  it("redirects an unauthenticated student path to / (no sign-in bounce)", async () => {
    getSessionCookie.mockReturnValue(null);
    const res = await updateSession(reqFor("/my-classes"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/");
    expect(loc.searchParams.has("next")).toBe(false);
  });

  // /settings, /payments, /notifications are the rest of the (app) route
  // group (authoritatively guarded by requireTeacher() in its layout); the
  // middleware gate is defense in depth and must cover them too.
  it.each(["/settings", "/payments", "/notifications"])(
    "redirects an unauthenticated teacher path %s to /sign-in with a next param",
    async (path) => {
      getSessionCookie.mockReturnValue(null);
      const res = await updateSession(reqFor(path));
      expect(res.status).toBe(307);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/sign-in");
      expect(loc.searchParams.get("next")).toBe(path);
    },
  );

  it("does not gate /ajustes — it never existed as a route (replaced by /settings)", async () => {
    getSessionCookie.mockReturnValue(null);
    const res = await updateSession(reqFor("/ajustes"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects an unauthenticated admin path to /sign-in", async () => {
    getSessionCookie.mockReturnValue(null);
    const res = await updateSession(reqFor("/admin/payments"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/sign-in");
    expect(loc.searchParams.get("next")).toBe("/admin/payments");
  });

  it("lets an authenticated user through a protected path (no redirect)", async () => {
    getSessionCookie.mockReturnValue("session-token");
    const res = await updateSession(reqFor("/dashboard"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
  });

  it("bounces an authenticated non-superuser away from /sign-in to /dashboard", async () => {
    getSessionCookie.mockReturnValue("session-token");
    getCookieCache.mockResolvedValue({ user: { email: "t@x.com" } });
    const res = await updateSession(reqFor("/sign-in"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard");
  });

  it("bounces an authenticated superuser away from /sign-in to /admin", async () => {
    getSessionCookie.mockReturnValue("session-token");
    getCookieCache.mockResolvedValue({ user: { email: "admin@x.com" } });
    isSuperuser.mockReturnValue(true);
    const res = await updateSession(reqFor("/sign-up"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/admin");
  });

  it("falls back to /dashboard when the cookie-cache is a miss (cache expired)", async () => {
    getSessionCookie.mockReturnValue("session-token");
    getCookieCache.mockResolvedValue(null);
    const res = await updateSession(reqFor("/sign-in"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard");
  });

  it("degrades to /dashboard without calling getCookieCache when BETTER_AUTH_SECRET is unset (misconfigured deploy env) — getCookieCache throws BetterAuthError otherwise", async () => {
    envState.betterAuthSecret = undefined;
    getSessionCookie.mockReturnValue("session-token");
    const res = await updateSession(reqFor("/sign-in"));
    expect(getCookieCache).not.toHaveBeenCalled();
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard");
  });
});

// Regression (preview redirected to https://0.0.0.0:3000/dashboard): self-hosted
// runs Next's standalone server, which builds request.nextUrl from the
// container's BIND address (HOSTNAME=0.0.0.0 + PORT=3000) and takes only the
// protocol from x-forwarded-proto. So behind Fly's proxy nextUrl.origin is
// "https://0.0.0.0:3000", and every redirect below used to hand the browser that
// unreachable origin. Redirects must resolve against APP_URL instead.
//
// The suites above pin only `loc.pathname`, which is exactly why this shipped —
// these assert the ORIGIN, from a request that arrives on the bind address the
// way a real proxied one does.
describe("updateSession — redirects resolve against the public origin (APP_URL)", () => {
  const BIND_ORIGIN = "https://0.0.0.0:3000";
  const PUBLIC_ORIGIN = "https://preview.spiralclass.com";

  it("sends the unauthenticated teacher bounce to APP_URL, preserving path + next", async () => {
    getSessionCookie.mockReturnValue(null);
    const res = await updateSession(new NextRequest(`${BIND_ORIGIN}/dashboard/classes`));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(PUBLIC_ORIGIN);
    expect(loc.pathname).toBe("/sign-in");
    expect(loc.searchParams.get("next")).toBe("/dashboard/classes");
  });

  it("sends the unauthenticated student bounce to APP_URL", async () => {
    getSessionCookie.mockReturnValue(null);
    const res = await updateSession(new NextRequest(`${BIND_ORIGIN}/my-classes`));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(PUBLIC_ORIGIN);
    expect(loc.pathname).toBe("/");
  });

  // The exact reported failure: signed-in visit to /sign-in bounced to
  // https://0.0.0.0:3000/dashboard.
  it("sends the authenticated /sign-in bounce to APP_URL, not the bind address", async () => {
    getSessionCookie.mockReturnValue("session-token");
    getCookieCache.mockResolvedValue({ user: { email: "t@x.com" } });
    const res = await updateSession(new NextRequest(`${BIND_ORIGIN}/sign-in`));
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/dashboard`);
  });

  it("sends the authenticated superuser bounce to APP_URL", async () => {
    getSessionCookie.mockReturnValue("session-token");
    getCookieCache.mockResolvedValue({ user: { email: "admin@x.com" } });
    isSuperuser.mockReturnValue(true);
    const res = await updateSession(new NextRequest(`${BIND_ORIGIN}/sign-in`));
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/admin`);
  });

  // Production and preview are different origins (D-26); the redirect origin
  // must follow APP_URL rather than being pinned to either.
  it("follows APP_URL per environment", async () => {
    envState.appUrl = "https://spiralclass.com";
    getSessionCookie.mockReturnValue("session-token");
    getCookieCache.mockResolvedValue({ user: { email: "t@x.com" } });
    const res = await updateSession(new NextRequest(`${BIND_ORIGIN}/sign-in`));
    expect(res.headers.get("location")).toBe("https://spiralclass.com/dashboard");
  });
});

describe("updateSession — ?ref= ambassador attribution", () => {
  it("stamps a first-party ref cookie when ?ref= is present and none is set yet", async () => {
    getSessionCookie.mockReturnValue(null);
    const res = await updateSession(reqFor("/?ref=ANA2026"));
    const cookie = res.cookies.get(REFERRAL_COOKIE);
    // normalizeReferralCode lower-cases the code so attribution is case-insensitive.
    expect(cookie?.value).toBe("ana2026");
    expect(cookie?.httpOnly).toBe(true);
  });

  it("does not overwrite an existing ref cookie (first attribution wins)", async () => {
    getSessionCookie.mockReturnValue(null);
    const req = new NextRequest("http://localhost/?ref=SECOND");
    req.cookies.set(REFERRAL_COOKIE, "FIRST");
    const res = await updateSession(req);
    // No fresh Set-Cookie for the ref cookie → the original stands.
    expect(res.cookies.get(REFERRAL_COOKIE)).toBeUndefined();
  });

  it("does not stamp attribution for an already-signed-in visitor", async () => {
    getSessionCookie.mockReturnValue("session-token");
    getCookieCache.mockResolvedValue({ user: { email: "t@x.com" } });
    const res = await updateSession(reqFor("/?ref=ANA2026"));
    expect(res.cookies.get(REFERRAL_COOKIE)).toBeUndefined();
  });
});

// Maintenance mode (D-76): MAINTENANCE_MODE walls off both apps. The web half
// runs here — before the auth gate — rewriting page requests to /maintenance
// (503) and answering non-allowlisted API requests with a 503 JSON, while the
// health check, the mobile config endpoint (how the app learns it's in
// maintenance), and the wall page itself stay reachable. An operator punches
// through with ?maintenance_bypass=<MAINTENANCE_BYPASS_TOKEN>.
describe("updateSession — maintenance mode", () => {
  it("is inert when MAINTENANCE_MODE is unset (protected path still auth-gates)", async () => {
    getSessionCookie.mockReturnValue("session-token");
    const res = await updateSession(reqFor("/dashboard"));
    expect(res.status).not.toBe(503);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("rewrites a page request to /maintenance with 503 + Retry-After when on", async () => {
    vi.stubEnv("MAINTENANCE_MODE", "1");
    // Even an authenticated hit gets the wall — maintenance short-circuits
    // before the auth gate.
    getSessionCookie.mockReturnValue("session-token");
    const res = await updateSession(reqFor("/dashboard"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-middleware-rewrite")).toContain("/maintenance");
    expect(res.headers.get("Retry-After")).toBe("3600");
  });

  it("walls an unauthenticated page hit too (no sign-in bounce during maintenance)", async () => {
    vi.stubEnv("MAINTENANCE_MODE", "1");
    getSessionCookie.mockReturnValue(null);
    const res = await updateSession(reqFor("/dashboard"));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toContain("/maintenance");
  });

  it("answers a non-allowlisted API request with a 503 maintenance JSON", async () => {
    vi.stubEnv("MAINTENANCE_MODE", "1");
    const res = await updateSession(reqFor("/api/teacher/overview"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: "maintenance" });
  });

  it.each(["/api/health", "/api/health/live", "/maintenance", "/api/csp-report"])(
    "keeps %s reachable while maintenance is on",
    async (path) => {
      vi.stubEnv("MAINTENANCE_MODE", "1");
      const res = await updateSession(reqFor(path));
      expect(res.status).not.toBe(503);
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    },
  );

  it("lets a request with a valid bypass cookie through to the normal flow", async () => {
    vi.stubEnv("MAINTENANCE_MODE", "1");
    vi.stubEnv("MAINTENANCE_BYPASS_TOKEN", "secret-op-token");
    getSessionCookie.mockReturnValue("session-token");
    const req = reqFor("/dashboard");
    req.cookies.set(MAINTENANCE_BYPASS_COOKIE, "secret-op-token");
    const res = await updateSession(req);
    expect(res.status).not.toBe(503);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("sets the bypass cookie and passes through when the token is in the query", async () => {
    vi.stubEnv("MAINTENANCE_MODE", "1");
    vi.stubEnv("MAINTENANCE_BYPASS_TOKEN", "secret-op-token");
    getSessionCookie.mockReturnValue("session-token");
    const res = await updateSession(reqFor("/dashboard?maintenance_bypass=secret-op-token"));
    expect(res.status).not.toBe(503);
    expect(res.cookies.get(MAINTENANCE_BYPASS_COOKIE)?.value).toBe("secret-op-token");
    expect(res.cookies.get(MAINTENANCE_BYPASS_COOKIE)?.httpOnly).toBe(true);
  });

  it("does not bypass on a wrong token (still walled)", async () => {
    vi.stubEnv("MAINTENANCE_MODE", "1");
    vi.stubEnv("MAINTENANCE_BYPASS_TOKEN", "secret-op-token");
    const res = await updateSession(reqFor("/dashboard?maintenance_bypass=guess"));
    expect(res.status).toBe(503);
  });

  it("cannot bypass when no MAINTENANCE_BYPASS_TOKEN is configured", async () => {
    vi.stubEnv("MAINTENANCE_MODE", "1");
    // No token set — a stray bypass cookie must not open the wall.
    const req = reqFor("/dashboard");
    req.cookies.set(MAINTENANCE_BYPASS_COOKIE, "anything");
    const res = await updateSession(req);
    expect(res.status).toBe(503);
  });
});
