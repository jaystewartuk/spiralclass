import { beforeEach, describe, expect, it, vi } from "vitest";

// /sign-in and /sign-up send a visitor with a LIVE session on their way (the
// safe ?next=, else the role landing) — from the page, on the authoritative
// getSession(), never from the middleware on cookie presence. The regression
// this pins: a cookie that outlived its session used to bounce /sign-in →
// /dashboard → /sign-in → … until the browser gave up on a blank page, and an
// invitation's ?next= was lost on the first hop. Here "cookie but no session"
// is simply getAuthUser() → null, and the form must render.

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

const getAuthUser = vi.fn<() => Promise<{ id: string; email: string } | null>>(async () => null);
vi.mock("@/lib/auth", () => ({ getAuthUser: () => getAuthUser() }));

const finalizeSignIn = vi.fn(async (_next: string | null, _user: unknown, _intent?: string) =>
  Promise.resolve("/dashboard"),
);
vi.mock("@/app/actions/session", () => ({
  finalizeSignIn: (next: string | null, user: unknown, intent?: string) =>
    finalizeSignIn(next, user, intent),
}));

const { redirectIfSignedIn } = await import("@/app/(auth)/redirect-if-signed-in");

async function redirectedTo(next: string | null): Promise<string | null> {
  try {
    await redirectIfSignedIn(next);
    return null;
  } catch (err) {
    if (err instanceof RedirectError) return err.url;
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(null);
  finalizeSignIn.mockResolvedValue("/dashboard");
});

describe("redirectIfSignedIn", () => {
  it("renders the form (no redirect, no landing lookup) when there is no live session — the stale-cookie case", async () => {
    expect(await redirectedTo("/i/abc")).toBeNull();
    expect(finalizeSignIn).not.toHaveBeenCalled();
  });

  it("sends a live session to the safe ?next= — an invitation's resume-after-login survives", async () => {
    getAuthUser.mockResolvedValue({ id: "u1", email: "student@example.com" });
    finalizeSignIn.mockResolvedValue("/i/abc");
    expect(await redirectedTo("/i/abc")).toBe("/i/abc");
    expect(finalizeSignIn).toHaveBeenCalledWith(
      "/i/abc",
      { id: "u1", email: "student@example.com" },
      "sign-in",
    );
  });

  it("sends a live session with no ?next= to the role landing finalizeSignIn resolves", async () => {
    getAuthUser.mockResolvedValue({ id: "u1", email: "t@example.com" });
    finalizeSignIn.mockResolvedValue("/my-classes");
    expect(await redirectedTo(null)).toBe("/my-classes");
    expect(finalizeSignIn).toHaveBeenCalledWith(null, expect.anything(), "sign-in");
  });

  it("never redirects to a sign-in page — an identity with no account renders the form instead of looping", async () => {
    getAuthUser.mockResolvedValue({ id: "u1", email: "nobody@example.com" });
    finalizeSignIn.mockResolvedValue("/sign-in?error=no-account&email=nobody%40example.com");
    expect(await redirectedTo(null)).toBeNull();
  });

  it("treats the teacher-email conflict the same way (form, not a self-redirect)", async () => {
    getAuthUser.mockResolvedValue({ id: "u1", email: "t@example.com" });
    finalizeSignIn.mockResolvedValue("/sign-in?error=teacher-email-conflict");
    expect(await redirectedTo("/i/abc")).toBeNull();
  });

  it("asks with sign-in intent, never sign-up — visiting the page must not mint a teacher (D-56)", async () => {
    getAuthUser.mockResolvedValue({ id: "u1", email: "new@example.com" });
    await redirectedTo(null);
    expect(finalizeSignIn.mock.calls[0]?.[2]).toBe("sign-in");
  });
});
