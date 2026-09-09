import { describe, expect, it } from "vitest";
import { OTP_RESEND_COOLDOWN_STEPS_SECONDS, otpResendCooldownSeconds } from "./otp-resend";

describe("otpResendCooldownSeconds", () => {
  it("starts at the first step for the first resend", () => {
    expect(otpResendCooldownSeconds(0)).toBe(OTP_RESEND_COOLDOWN_STEPS_SECONDS[0]);
  });

  it("escalates through each step as resends pile up", () => {
    expect(otpResendCooldownSeconds(1)).toBe(OTP_RESEND_COOLDOWN_STEPS_SECONDS[1]);
    expect(otpResendCooldownSeconds(2)).toBe(OTP_RESEND_COOLDOWN_STEPS_SECONDS[2]);
  });

  it("holds at the last step beyond the defined range instead of throwing", () => {
    const lastStep =
      OTP_RESEND_COOLDOWN_STEPS_SECONDS[OTP_RESEND_COOLDOWN_STEPS_SECONDS.length - 1];
    expect(otpResendCooldownSeconds(10)).toBe(lastStep);
  });

  it("clamps a negative count to the first step", () => {
    expect(otpResendCooldownSeconds(-1)).toBe(OTP_RESEND_COOLDOWN_STEPS_SECONDS[0]);
  });
});
