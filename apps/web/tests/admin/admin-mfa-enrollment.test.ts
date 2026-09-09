import { beforeEach, describe, expect, it, vi } from "vitest";

// enrollAdminTotp against better-auth's two-factor plugin.
//
// better-auth 1.7 added an emailed-OTP second factor beside TOTP, which made
// `enableTwoFactor` return a union discriminated on `method` — the OTP variant
// carries no `totpURI`/`backupCodes` at all. D-40 is TOTP-only, so these pin
// that we ask for TOTP by name rather than inheriting whatever the plugin
// defaults to, and that a non-TOTP response fails loudly instead of handing
// the enrolment screen an empty QR code.

const enableTwoFactor = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/server", () => ({ auth: { api: { enableTwoFactor } } }));

const { enrollAdminTotp } = await import("@/lib/auth/admin-mfa");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enrollAdminTotp", () => {
  it("asks for TOTP explicitly and returns the secret to show", async () => {
    enableTwoFactor.mockResolvedValue({
      method: "totp",
      totpURI: "otpauth://totp/SpiralClass:admin?secret=ABC",
      backupCodes: ["aaa-111", "bbb-222"],
    });

    const result = await enrollAdminTotp();

    expect(enableTwoFactor).toHaveBeenCalledWith(
      expect.objectContaining({ body: { method: "totp" } }),
    );
    expect(result).toEqual({
      totpURI: "otpauth://totp/SpiralClass:admin?secret=ABC",
      backupCodes: ["aaa-111", "bbb-222"],
    });
  });

  it("refuses an emailed-OTP enrolment rather than returning an empty secret", async () => {
    enableTwoFactor.mockResolvedValue({ method: "otp" });

    await expect(enrollAdminTotp()).rejects.toThrow(/otp/);
  });
});
