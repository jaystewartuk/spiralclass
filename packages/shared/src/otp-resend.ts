// OTP "resend code" cooldown policy — shared by web (sign-in/sign-up
// check-email step, checkout-result resend link) and mobile (OtpCodeStep) so
// both surfaces throttle a tap on "resend" the same way.
//
// The client-side cooldown is a UX nicety only (discourages accidental
// double-taps and mailbox spam); the real cap is server-side per-IP/per-email
// rate limiting (apps/web/src/lib/rate-limit.ts). Cooldown steps escalate —
// 30s, 60s, then 120s for every resend after that — so a person who keeps
// tapping "resend" slows down well before hitting the server's 3-per-5-minute
// per-email limit (30 + 60 + 120 = 210s, under the 300s window).
export const OTP_RESEND_COOLDOWN_STEPS_SECONDS = [30, 60, 120] as const;

/**
 * Seconds to wait before "resend" is enabled again, given how many resends
 * have already happened in this code-request cycle (0 = right after the
 * initial send / first resend allowed). Escalates through
 * OTP_RESEND_COOLDOWN_STEPS_SECONDS, then holds at the last step.
 */
export function otpResendCooldownSeconds(resendCount: number): number {
  const steps = OTP_RESEND_COOLDOWN_STEPS_SECONDS;
  const index = Math.min(Math.max(resendCount, 0), steps.length - 1);
  return steps[index];
}
