import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the delivery logic from env/DB/Resend: assert it builds a code-only
// email carrying the OTP and fails loudly on a send error.

const sends: { to: string; subject: string; body: string; html?: string }[] = [];
let nextFail = false;

const captureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://spiralclass.com" }),
}));
vi.mock("@/lib/prisma", () => ({
  // resolveLocale queries by email; return null → es-MX default. (Rejecting also
  // works — the lookup is best-effort — but null keeps the test deterministic.)
  prisma: {
    teacher: { findFirst: vi.fn().mockResolvedValue(null) },
    student: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/email", () => ({
  getEmailClientKind: () => "resend",
  getEmailClient: () => ({
    async send(input: { to: string; subject: string; body: string; html?: string }) {
      if (nextFail) {
        nextFail = false;
        // The shape production actually returns when Resend refuses the send:
        // an unverified sending domain, or a key scoped to a different one.
        return {
          ok: false,
          error: 'resend-403: {"message":"domain is not verified"}',
          code: "resend-403",
          retryable: false,
        };
      }
      sends.push(input);
      return { ok: true, providerMessageId: "stub-1" };
    },
  }),
}));

import { sendBetterAuthEmailOtp } from "@/lib/auth/email-otp-delivery";

describe("sendBetterAuthEmailOtp", () => {
  beforeEach(() => {
    sends.length = 0;
    nextFail = false;
    captureException.mockClear();
  });

  it("sends a code-only email that contains the OTP and no magic link", async () => {
    await sendBetterAuthEmailOtp({ email: "u@example.com", otp: "123456", type: "sign-in" });
    expect(sends).toHaveLength(1);
    const sent = sends[0];
    expect(sent.to).toBe("u@example.com");
    expect(sent.subject).toMatch(/código|code/i);
    expect(sent.body).toContain("123456");
    expect(sent.html).toContain("123456");
    // Magic-link delivery is dropped — the code email must carry no /m/login link.
    expect(sent.body).not.toContain("/m/login");
    expect(sent.html ?? "").not.toContain("/m/login");
  });

  it("throws when the email send fails so better-auth surfaces the error", async () => {
    nextFail = true;
    await expect(
      sendBetterAuthEmailOtp({ email: "u@example.com", otp: "123456", type: "sign-in" }),
    ).rejects.toThrow(/email-otp-send-failed/);
  });

  // Regression for AGENDAPROFE-1V: the failure reported only "send failed", and
  // the provider's reason went into Sentry `extra`, which is scrubbed to
  // "[Filtered]" on this project. The cause has to ride the exception value and
  // the tags — both of which survive — or the alert is unactionable.
  it("names the provider and its failure code in the exception and in the tags", async () => {
    nextFail = true;
    await expect(
      sendBetterAuthEmailOtp({ email: "u@example.com", otp: "123456", type: "sign-in" }),
    ).rejects.toThrow("email-otp-send-failed: resend resend-403");

    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, context] = captureException.mock.calls[0] as [
      Error,
      { tags: Record<string, string>; extra: Record<string, unknown> },
    ];
    expect(err).toBeInstanceOf(Error);
    expect(context.tags).toMatchObject({
      surface: "better-auth-email-otp",
      emailProvider: "resend",
      emailFailure: "resend-403",
    });
    // The provider's own body still goes along as detail, for the log line and
    // for the environments where `extra` survives. It is NOT called `error`:
    // logger.error() overwrites that key with the exception's own message.
    expect(context.extra.providerError).toContain("domain is not verified");
  });
});
