import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/auth/server-otp.ts plants a verification row in the exact shape
// better-auth's emailOTP plugin expects for a "sign-in" OTP, then lets its
// own public auth.api.signInEmailOTP do all real verification/session work.
// This pins two things:
//   1. The hash this module computes for a given code is SHA-256 → base64url
//      (no padding) of the plaintext OTP — the exact algorithm better-auth's
//      own internal `defaultKeyHasher` uses (better-auth/dist/plugins/email-
//      otp/utils.mjs — not importable directly here, it's outside the
//      package's public `exports` map) — and that the identifier is
//      `sign-in-otp-<email>`, matching `toOTPIdentifier("sign-in", email)`.
//      This is the load-bearing assumption the whole "plant, don't hand-roll
//      sessions" design rests on; an upstream algorithm change breaks this
//      test, not just a live notification-auto-login click.
//   2. mintServerSideOtpCode/mintServerSideOtpSession write the row with the
//      right identifier/value/expiry shape and clear any stale row first.

function expectedHash(otp: string): string {
  return createHash("sha256").update(otp).digest("base64url");
}

const state: {
  rows: Array<{ identifier: string; value: string; expiresAt: Date }>;
  deleteManyCalls: Array<{ identifier: string }>;
} = { rows: [], deleteManyCalls: [] };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    verification: {
      deleteMany: vi.fn(async ({ where }: { where: { identifier: string } }) => {
        state.deleteManyCalls.push({ identifier: where.identifier });
        state.rows = state.rows.filter((r) => r.identifier !== where.identifier);
        return { count: 0 };
      }),
      create: vi.fn(
        async ({ data }: { data: { identifier: string; value: string; expiresAt: Date } }) => {
          state.rows.push(data);
          return data;
        },
      ),
    },
  },
}));

const signInEmailOTPMock = vi.fn(async (input: { body: { email: string; otp: string } }) => ({
  token: "session-token",
  user: { id: "u-1", email: input.body.email },
}));
vi.mock("@/lib/auth/server", () => ({
  auth: { api: { signInEmailOTP: (input: unknown) => signInEmailOTPMock(input as never) } },
}));

vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const { mintServerSideOtpCode, mintServerSideOtpSession } = await import("@/lib/auth/server-otp");

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.deleteManyCalls = [];
});

describe("mintServerSideOtpCode", () => {
  it("plants a verification row whose hash matches better-auth's own hash algorithm", async () => {
    const code = await mintServerSideOtpCode("mira@example.com");
    expect(code).toMatch(/^\d{6}$/);

    expect(state.rows).toHaveLength(1);
    const row = state.rows[0]!;
    expect(row.identifier).toBe("sign-in-otp-mira@example.com");

    const [storedHash, attempts] = row.value.split(":");
    expect(attempts).toBe("0");
    expect(storedHash).toBe(expectedHash(code));
  });

  it("clears any stale row for the same identifier before planting", async () => {
    await mintServerSideOtpCode("mira@example.com");
    await mintServerSideOtpCode("mira@example.com");
    expect(state.deleteManyCalls).toHaveLength(2);
    expect(state.rows).toHaveLength(1);
  });

  it("respects a custom TTL", async () => {
    // Fake timers freeze Date.now() for the whole mint call, so this asserts
    // the exact TTL instead of a real-clock window — a real-clock window is
    // inherently flaky here since mintServerSideOtpCode's own Date.now() read
    // happens an unbounded (if usually tiny) number of microtasks after this
    // test's, with no upper bound on scheduling delay under CI load.
    vi.useFakeTimers();
    try {
      const before = Date.now();
      await mintServerSideOtpCode("mira@example.com", 600);
      const row = state.rows[0]!;
      const ttlMs = row.expiresAt.getTime() - before;
      expect(ttlMs).toBe(600_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mintServerSideOtpSession", () => {
  it("plants a code and immediately consumes it via the real signInEmailOTP endpoint", async () => {
    const result = await mintServerSideOtpSession("mira@example.com", new Headers());
    expect(signInEmailOTPMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ email: "mira@example.com" }) }),
    );
    expect(result).toMatchObject({ token: "session-token", user: { email: "mira@example.com" } });
    // The planted row is left for signInEmailOTP's own atomic-consume logic —
    // this module never deletes it after mint, only before (stale-row guard).
    expect(state.rows).toHaveLength(1);
  });

  it("propagates a signInEmailOTP failure instead of swallowing it", async () => {
    signInEmailOTPMock.mockRejectedValueOnce(new Error("invalid otp"));
    await expect(mintServerSideOtpSession("mira@example.com", new Headers())).rejects.toThrow(
      "invalid otp",
    );
  });
});
