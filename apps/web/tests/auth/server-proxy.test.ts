import { describe, expect, it, vi } from "vitest";

// Regression for the "auth is not a function" 500 on every /api/auth/* request.
//
// `auth` in lib/auth/server.ts is a lazy Proxy. better-auth's toNextJsHandler
// branches on `"handler" in auth ? auth.handler(req) : auth(req)`. With only a
// `get` trap, `"handler" in auth` hit the empty Proxy target and returned
// false, so the route fell to `auth(request)` — calling a non-callable Proxy —
// and threw "auth is not a function" (500 on sign-in, social AND email-OTP).
// The `has` trap forwards `in` to the resolved instance; this locks that in.

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://spiralclass.com" }),
  isProductionDeployment: () => false,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/email-otp-delivery", () => ({
  sendBetterAuthEmailOtp: vi.fn(),
}));

import { auth } from "@/lib/auth/server";
import { toNextJsHandler } from "better-auth/next-js";

describe("lazy auth proxy", () => {
  it("forwards the `in` operator to the resolved instance", () => {
    // The exact check better-auth's toNextJsHandler makes to tell an instance
    // apart from a bare handler function.
    expect("handler" in auth).toBe(true);
    expect("api" in auth).toBe(true);
    expect(typeof auth.handler).toBe("function");
  });

  it("toNextJsHandler(auth) selects the instance-handler branch, not the Proxy", () => {
    // `POST` is a real function; the pre-fix bug was that it would call
    // `auth(request)` (Proxy, not callable) instead of `auth.handler(request)`.
    const { GET, POST } = toNextJsHandler(auth);
    expect(typeof GET).toBe("function");
    expect(typeof POST).toBe("function");
  });
});
