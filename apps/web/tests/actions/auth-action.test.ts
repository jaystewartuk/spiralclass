import { beforeEach, describe, expect, it, vi } from "vitest";

// Passwordless email-OTP auth actions (D-40). better-auth's emailOTP plugin
// gives us anti-enumeration for free (it always attempts the send), so the
// pins here are: the rate-limit gate, the send/verify wiring onto
// auth.api.sendVerificationOTP / auth.api.signInEmailOTP, and the
// finalizeSignIn redirect handoff.

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const sendVerificationOTP = vi.fn(async () => ({ success: true }));
const signInEmailOTP = vi.fn(async () => ({ token: "t", user: {} }));
const signOut = vi.fn(async () => ({}));
vi.mock("@/lib/auth/server", () => ({
  auth: { api: { sendVerificationOTP, signInEmailOTP, signOut } },
}));

// `ipRlOk` gates the per-IP check (always the first rateLimit() call in each
// action); `emailRlOk` gates the per-email check that follows it once the
// form data parses. Keeping them separate lets tests block one without the
// other, mirroring the two independent scopes in app/actions/auth.ts.
const state = { ipRlOk: true, emailRlOk: true, retryAfterMs: 4242 };
const rateLimit = vi.fn(async (_id: string, opts: { scope: string }) => {
  const ok = opts.scope.endsWith("-email") ? state.emailRlOk : state.ipRlOk;
  return { ok, retryAfterMs: ok ? 0 : state.retryAfterMs };
});
vi.mock("@/lib/rate-limit", () => ({
  clientIp: vi.fn(async () => "1.2.3.4"),
  rateLimit,
}));

const finalizeSignIn = vi.fn(async () => "/dashboard");
vi.mock("@/app/actions/session", () => ({ finalizeSignIn }));

const {
  requestSignInCodeAction,
  requestTeacherSignupCodeAction,
  verifySignInCodeAction,
  signOutAction,
} = await import("@/app/actions/auth");

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.ipRlOk = true;
  state.emailRlOk = true;
  state.retryAfterMs = 4242;
  sendVerificationOTP.mockResolvedValue({ success: true });
  signInEmailOTP.mockResolvedValue({ token: "t", user: {} });
  finalizeSignIn.mockResolvedValue("/dashboard");
});

describe("requestSignInCodeAction", () => {
  it("blocks once IP rate-limited, before touching the email limit", async () => {
    state.ipRlOk = false;
    const res = await requestSignInCodeAction(undefined, form({ email: "a@b.com" }));
    expect(res).toMatchObject({ error: expect.any(String), retryAfterMs: state.retryAfterMs });
    expect(sendVerificationOTP).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  it("blocks once the per-email window is exhausted (resend abuse)", async () => {
    state.emailRlOk = false;
    const res = await requestSignInCodeAction(undefined, form({ email: "a@b.com" }));
    expect(res).toMatchObject({ error: expect.any(String), retryAfterMs: state.retryAfterMs });
    expect(sendVerificationOTP).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith(
      "a@b.com",
      expect.objectContaining({ scope: "sign-in-email" }),
    );
  });

  it("rejects an invalid email", async () => {
    const res = await requestSignInCodeAction(undefined, form({ email: "nope" }));
    expect(res).toHaveProperty("error");
  });

  it("sends a sign-in code", async () => {
    const res = await requestSignInCodeAction(undefined, form({ email: "real@b.com" }));
    expect(res).toEqual({ ok: true });
    expect(sendVerificationOTP).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: "real@b.com", type: "sign-in" } }),
    );
  });

  it("stays ok even when sending throws (anti-enumeration preserved)", async () => {
    sendVerificationOTP.mockRejectedValueOnce(new Error("smtp down"));
    const res = await requestSignInCodeAction(undefined, form({ email: "real@b.com" }));
    expect(res).toEqual({ ok: true });
  });
});

describe("requestTeacherSignupCodeAction", () => {
  it("sends a sign-up code", async () => {
    const res = await requestTeacherSignupCodeAction(
      undefined,
      form({ name: "Mira", email: "mira@b.com" }),
    );
    expect(res).toEqual({ ok: true });
    expect(sendVerificationOTP).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: "mira@b.com", type: "sign-in" } }),
    );
  });

  it("rejects invalid input without sending", async () => {
    const res = await requestTeacherSignupCodeAction(undefined, form({ name: "", email: "nope" }));
    expect(res).toHaveProperty("error");
    expect(sendVerificationOTP).not.toHaveBeenCalled();
  });

  it("blocks once the per-email window is exhausted (resend abuse)", async () => {
    state.emailRlOk = false;
    const res = await requestTeacherSignupCodeAction(
      undefined,
      form({ name: "Mira", email: "mira@b.com" }),
    );
    expect(res).toMatchObject({ error: expect.any(String), retryAfterMs: state.retryAfterMs });
    expect(sendVerificationOTP).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith(
      "mira@b.com",
      expect.objectContaining({ scope: "sign-up-email" }),
    );
  });
});

describe("verifySignInCodeAction", () => {
  it("blocks once rate-limited", async () => {
    state.ipRlOk = false;
    const res = await verifySignInCodeAction(undefined, form({ email: "a@b.com", code: "123456" }));
    expect(res).toHaveProperty("error");
    expect(signInEmailOTP).not.toHaveBeenCalled();
  });

  it("returns an error for a bad code", async () => {
    signInEmailOTP.mockRejectedValueOnce(new Error("invalid otp"));
    const res = await verifySignInCodeAction(undefined, form({ email: "a@b.com", code: "000000" }));
    expect(res).toHaveProperty("error");
    expect(finalizeSignIn).not.toHaveBeenCalled();
  });

  it("redirects to the resolved destination on success", async () => {
    finalizeSignIn.mockResolvedValueOnce("/dashboard");
    let url = "";
    try {
      await verifySignInCodeAction(undefined, form({ email: "a@b.com", code: "123456" }));
    } catch (err) {
      if (err instanceof RedirectError) url = err.url;
      else throw err;
    }
    expect(signInEmailOTP).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: "a@b.com", otp: "123456", name: undefined } }),
    );
    expect(url).toBe("/dashboard");
  });

  it("trims whitespace from the code before verifying", async () => {
    try {
      await verifySignInCodeAction(undefined, form({ email: "a@b.com", code: " 123456 " }));
    } catch {
      // redirect throws
    }
    expect(signInEmailOTP).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ otp: "123456" }) }),
    );
  });

  it("carries a trimmed name through to the verify call (new-account path)", async () => {
    try {
      await verifySignInCodeAction(
        undefined,
        form({ email: "a@b.com", code: "123456", name: "  Mira  " }),
      );
    } catch {
      // redirect throws
    }
    expect(signInEmailOTP).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ name: "Mira" }) }),
    );
  });

  it("passes next to finalizeSignIn", async () => {
    finalizeSignIn.mockResolvedValueOnce("/my-classes/123");
    try {
      await verifySignInCodeAction(
        undefined,
        form({ email: "a@b.com", code: "123456", next: "/my-classes/123" }),
      );
    } catch {
      // redirect throws
    }
    expect(finalizeSignIn).toHaveBeenCalledWith("/my-classes/123", {}, "sign-in");
  });

  it("defaults intent to sign-in when the field is missing (D-56)", async () => {
    try {
      await verifySignInCodeAction(undefined, form({ email: "a@b.com", code: "123456" }));
    } catch {
      // redirect throws
    }
    expect(finalizeSignIn).toHaveBeenCalledWith(null, {}, "sign-in");
  });

  it("passes intent: sign-up through to finalizeSignIn from the sign-up form", async () => {
    try {
      await verifySignInCodeAction(
        undefined,
        form({ email: "a@b.com", code: "123456", intent: "sign-up" }),
      );
    } catch {
      // redirect throws
    }
    expect(finalizeSignIn).toHaveBeenCalledWith(null, {}, "sign-up");
  });

  it("ignores an unrecognized intent value and falls back to sign-in", async () => {
    try {
      await verifySignInCodeAction(
        undefined,
        form({ email: "a@b.com", code: "123456", intent: "admin-backdoor" }),
      );
    } catch {
      // redirect throws
    }
    expect(finalizeSignIn).toHaveBeenCalledWith(null, {}, "sign-in");
  });
});

describe("signOutAction", () => {
  it("signs out and redirects home", async () => {
    let url = "";
    try {
      await signOutAction();
    } catch (err) {
      if (err instanceof RedirectError) url = err.url;
      else throw err;
    }
    expect(signOut).toHaveBeenCalled();
    expect(url).toBe("/");
  });
});
