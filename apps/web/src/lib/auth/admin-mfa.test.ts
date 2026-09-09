import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin TOTP enrolment against better-auth's two-factor plugin (D-25/D-40 —
// TOTP only, no WebAuthn, no passkeys, no teacher MFA).
//
// WHAT THIS PINS, AND WHY IT IS NOT COVERED ELSEWHERE. The action-level suite
// (tests/actions/admin-mfa-action.test.ts) mocks this whole module out, so the
// call INTO better-auth had no test at all. better-auth widened
// enableTwoFactor's return to `{ method: "otp" } | { method: "totp"; ... }`,
// which broke the build — and the interesting half is not the compile error
// but that the plugin can enrol a DIFFERENT second factor than the one D-40
// chose, selected by a default we were not setting.

const enableTwoFactor = vi.fn();
vi.mock("@/lib/auth/server", () => ({ auth: { api: { enableTwoFactor } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { enrollAdminTotp } = await import("@/lib/auth/admin-mfa");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enrollAdminTotp", () => {
  it("asks better-auth for TOTP rather than letting its default choose", async () => {
    enableTwoFactor.mockResolvedValueOnce({
      method: "totp",
      totpURI: "otpauth://totp/SpiralClass:a@b.com?secret=S&issuer=SpiralClass",
      backupCodes: ["aaaa-bbbb"],
    });

    await enrollAdminTotp();

    expect(enableTwoFactor).toHaveBeenCalledTimes(1);
    expect(enableTwoFactor.mock.calls[0][0].body).toEqual({ method: "totp" });
  });

  it("returns the secret and backup codes from the TOTP arm", async () => {
    enableTwoFactor.mockResolvedValueOnce({
      method: "totp",
      totpURI: "otpauth://totp/SpiralClass:a@b.com?secret=S&issuer=SpiralClass",
      backupCodes: ["aaaa-bbbb", "cccc-dddd"],
    });

    await expect(enrollAdminTotp()).resolves.toEqual({
      totpURI: "otpauth://totp/SpiralClass:a@b.com?secret=S&issuer=SpiralClass",
      backupCodes: ["aaaa-bbbb", "cccc-dddd"],
    });
  });

  it("throws rather than returning an OTP enrolment with no secret to scan", async () => {
    // The other arm of the union. It carries neither totpURI nor backupCodes,
    // so passing it through would render an empty QR code and an admin who
    // believes they have enrolled.
    enableTwoFactor.mockResolvedValueOnce({ method: "otp" });

    // Asserted on the arm it rejects, not on the sentence: the message is
    // #1111's wording and this test is about the refusal, not the phrasing.
    await expect(enrollAdminTotp()).rejects.toThrow(/otp/i);
  });
});
