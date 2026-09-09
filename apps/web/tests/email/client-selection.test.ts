import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ENV_KEYS, SERVER_ENV_KEYS } from "@/lib/env";

// getEmailClient() picks a provider from env at first call and caches it —
// each test re-imports the module (env.ts and email/index.ts both cache
// module-level state) so process.env mutations actually take effect.

const ORIGINAL = { ...process.env };
const APP_ENV_KEYS = [...SERVER_ENV_KEYS, ...CLIENT_ENV_KEYS];

function setEnv(patch: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL };
  for (const k of APP_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function withBaseRequired(extra: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: "postgres://x/y",
    DIRECT_URL: "postgres://x/y",
    SESSION_SECRET: "a".repeat(32),
    ...extra,
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("getEmailClient provider selection", () => {
  it("falls back to the stub client when no provider is configured", async () => {
    setEnv(withBaseRequired());
    const { getEmailClient, getEmailClientKind } = await import("@/lib/email");
    getEmailClient();
    expect(getEmailClientKind()).toBe("stub");
  });

  it("uses Resend when only Resend creds are set", async () => {
    setEnv(withBaseRequired({ RESEND_API_KEY: "re_xxx" }));
    const { getEmailClient, getEmailClientKind } = await import("@/lib/email");
    getEmailClient();
    expect(getEmailClientKind()).toBe("resend");
  });

  it("prefers SES over Resend when both are configured (metered, no monthly floor)", async () => {
    setEnv(
      withBaseRequired({
        RESEND_API_KEY: "re_xxx",
        SES_REGION: "us-east-1",
        SES_ACCESS_KEY_ID: "AKIA_TEST",
        SES_SECRET_ACCESS_KEY: "secret",
      }),
    );
    const { getEmailClient, getEmailClientKind } = await import("@/lib/email");
    getEmailClient();
    expect(getEmailClientKind()).toBe("ses");
  });

  it("EMAIL_PROVIDER=resend forces Resend even when SES creds are also present", async () => {
    setEnv(
      withBaseRequired({
        RESEND_API_KEY: "re_xxx",
        SES_REGION: "us-east-1",
        SES_ACCESS_KEY_ID: "AKIA_TEST",
        SES_SECRET_ACCESS_KEY: "secret",
        EMAIL_PROVIDER: "resend",
      }),
    );
    const { getEmailClient, getEmailClientKind } = await import("@/lib/email");
    getEmailClient();
    expect(getEmailClientKind()).toBe("resend");
  });

  it("EMAIL_PROVIDER=ses without SES creds falls back to Resend rather than the stub", async () => {
    setEnv(
      withBaseRequired({
        RESEND_API_KEY: "re_xxx",
        EMAIL_PROVIDER: "ses",
      }),
    );
    const { getEmailClient, getEmailClientKind } = await import("@/lib/email");
    getEmailClient();
    expect(getEmailClientKind()).toBe("resend");
  });
});
