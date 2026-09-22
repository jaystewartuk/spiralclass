import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";

// Admin-only TOTP enrolment on better-auth's two-factor plugin (D-40 narrows
// D-25 to TOTP-only — no WebAuthn/passkeys, no teacher MFA). One secret per
// user; there is no per-session "stepped up" flag to track — lib/admin.ts
// gates purely on user.twoFactorEnabled, matching the target surface in
// docs/features/authentication.md.

export type AdminEnrollResult = { totpURI: string; backupCodes: string[] };

// Starts (or restarts) enrolment: generates a fresh TOTP secret + backup
// codes. Does NOT set twoFactorEnabled — that flips only once
// verifyAdminTotpEnrollment succeeds.
export async function enrollAdminTotp(): Promise<AdminEnrollResult> {
  const result = await auth.api.enableTwoFactor({
    // better-auth 1.7 added an emailed-OTP second factor beside TOTP and made
    // this response a union on `method`. D-40 is TOTP-only, so ask for it by
    // name rather than leaning on the plugin's default, and treat anything
    // else as a misconfiguration — the OTP variant carries no secret, so
    // there would be nothing for the enrolment screen to show.
    body: { method: "totp" },
    headers: await headers(),
  });
  if (result.method !== "totp") {
    throw new Error(`admin MFA enrolment returned ${result.method}, expected totp`);
  }
  return { totpURI: result.totpURI, backupCodes: result.backupCodes };
}

// Confirms the 6-digit code from the authenticator app against the secret
// minted by enrollAdminTotp(). On success, better-auth flips
// user.twoFactorEnabled to true.
export async function verifyAdminTotpEnrollment(
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await auth.api.verifyTOTP({ body: { code }, headers: await headers() });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "verification failed" };
  }
}

export async function disableAdminTotp(): Promise<void> {
  await auth.api.disableTwoFactor({ body: {}, headers: await headers() });
}
