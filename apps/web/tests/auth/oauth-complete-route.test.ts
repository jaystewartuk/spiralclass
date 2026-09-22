import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// /auth/complete — the post-OAuth (Google Sign-In) landing. It must re-run the
// same role-aware routing (finalizeSignIn) the email-OTP rail gets inline, using
// the session established by the better-auth callback, and it must sanitize the
// ?next param before handing it on.

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const getSession = vi.fn();
vi.mock("@/lib/auth/server", () => ({ auth: { api: { getSession } } }));

const finalizeSignIn = vi.fn(async () => "/dashboard");
vi.mock("@/app/actions/session", () => ({ finalizeSignIn }));

// Literal, not the APP_URL const below — vi.mock is hoisted above it.
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://preview.spiralclass.com" }),
}));
const APP_URL = "https://preview.spiralclass.com";

const { GET } = await import("@/app/auth/complete/route");

// Requests arrive on the container's BIND address self-hosted — Next's
// standalone server builds nextUrl from HOSTNAME (0.0.0.0) + PORT, not the
// proxied Host header — so the landing redirect must resolve against APP_URL
// rather than the request's own origin, or it hands the browser
// https://0.0.0.0:3000/... See lib/public-url.ts.
function req(url: string): NextRequest {
  return new NextRequest(`https://0.0.0.0:3000${url}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  finalizeSignIn.mockResolvedValue("/dashboard");
});

describe("GET /auth/complete", () => {
  it("passes the established user + valid next to finalizeSignIn and redirects there", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "mira@example.com" } });
    finalizeSignIn.mockResolvedValue("/onboarding/timezone");

    const res = await GET(req("/auth/complete?next=%2Fdashboard"));

    expect(finalizeSignIn).toHaveBeenCalledWith(
      "/dashboard",
      { id: "u1", email: "mira@example.com" },
      "sign-in",
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${APP_URL}/onboarding/timezone`);
  });

  it("passes null user when no session is present (finalizeSignIn bounces to sign-in)", async () => {
    getSession.mockResolvedValue(null);
    finalizeSignIn.mockResolvedValue("/sign-in?error=no-session");

    const res = await GET(req("/auth/complete"));

    expect(finalizeSignIn).toHaveBeenCalledWith(null, null, "sign-in");
    expect(res.headers.get("location")).toBe(`${APP_URL}/sign-in?error=no-session`);
  });

  it("drops an open-redirect next (non-slash) to null", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "mira@example.com" } });

    await GET(req("/auth/complete?next=https%3A%2F%2Fevil.example"));

    expect(finalizeSignIn).toHaveBeenCalledWith(
      null,
      { id: "u1", email: "mira@example.com" },
      "sign-in",
    );
  });

  it("drops a protocol-relative next (//evil.com) to null", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "mira@example.com" } });

    await GET(req("/auth/complete?next=%2F%2Fevil.com"));

    expect(finalizeSignIn).toHaveBeenCalledWith(
      null,
      { id: "u1", email: "mira@example.com" },
      "sign-in",
    );
  });

  it("passes intent: sign-up through from the GoogleSignInButton's callbackURL query (D-56)", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "mira@example.com" } });

    await GET(req("/auth/complete?intent=sign-up"));

    expect(finalizeSignIn).toHaveBeenCalledWith(
      null,
      { id: "u1", email: "mira@example.com" },
      "sign-up",
    );
  });

  it("ignores an unrecognized intent value and falls back to sign-in", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "mira@example.com" } });

    await GET(req("/auth/complete?intent=admin-backdoor"));

    expect(finalizeSignIn).toHaveBeenCalledWith(
      null,
      { id: "u1", email: "mira@example.com" },
      "sign-in",
    );
  });
});
