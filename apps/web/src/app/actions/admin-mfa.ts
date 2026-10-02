"use server";

/* eslint-disable @typescript-eslint/no-unused-vars -- server actions wired to
 * useActionState must accept (prev, formData); the start action takes no input. */

import { resolveAdminActor } from "@/lib/admin";
import { getAuthUser } from "@/lib/auth";
import { enrollAdminTotp, verifyAdminTotpEnrollment } from "@/lib/auth/admin-mfa";
import { setAdminStepUp } from "@/lib/auth/admin-stepup";
import { getPreferredLocale } from "@/lib/i18n";
import { createT } from "@spiralclass/shared";

// TOTP enrolment + per-session step-up for ADMIN sessions
// (docs/decisions/D-25.md, narrowed by D-40 to TOTP-only, no
// WebAuthn/passkeys). Gates on resolveAdminActor() instead of requireAdmin():
// an admin need not be a teacher, and these are the ONE admin surface that
// doesn't call requireAdmin() — requiring a step-up to reach the surface that
// grants it would be a redirect loop. On a successful TOTP verify we mint the
// session-bound step-up proof (security audit H-1) so the admin gate treats
// AAL2 as actually presented, not merely enrolled. The success path is a
// client-side full navigation to /admin so the proof cookie is committed
// before the admin gate re-checks.

export type AdminMfaState =
  | {
      error?: string;
      enrolled?: { totpURI: string; secret: string };
      verified?: boolean;
    }
  | undefined;

export async function startAdminMfaEnrollmentAction(_prev: AdminMfaState): Promise<AdminMfaState> {
  await resolveAdminActor();
  const t = createT(await getPreferredLocale());
  try {
    const r = await enrollAdminTotp();
    // The `secret=` query param on an otpauth:// URI is the manual-entry key
    // authenticator apps show alongside (or instead of) a scanned QR.
    const secret = new URL(r.totpURI).searchParams.get("secret") ?? "";
    return { enrolled: { totpURI: r.totpURI, secret } };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : t("web.action.admin.mfa.startFailed"),
    };
  }
}

export async function verifyAdminMfaEnrollmentAction(
  _prev: AdminMfaState,
  formData: FormData,
): Promise<AdminMfaState> {
  await resolveAdminActor();
  const t = createT(await getPreferredLocale());
  const code = String(formData.get("code") ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    return {
      error: t("web.action.admin.mfa.invalidCode"),
    };
  }
  const r = await verifyAdminTotpEnrollment(code);
  if (!r.ok) return { error: r.error ?? t("web.action.admin.mfa.incorrectCode") };
  // verifyAdminTotpEnrollment flipped user.twoFactorEnabled. Also mint the
  // session step-up proof so the just-enrolled admin isn't immediately bounced
  // back here by the gate's per-session check. The client navigates on ok.
  const user = await getAuthUser();
  if (user) await setAdminStepUp(user.id);
  return { verified: true };
}

// Per-session step-up for an ALREADY-enrolled admin (security audit H-1): the
// admin gate requires a fresh TOTP proof, not just the enrolment flag, so a
// session that never presented a code is sent here to present one. Verifies the
// code against the enrolled secret and, on success, mints the step-up proof.
export async function verifyAdminMfaStepUpAction(
  _prev: AdminMfaState,
  formData: FormData,
): Promise<AdminMfaState> {
  await resolveAdminActor();
  const t = createT(await getPreferredLocale());
  const code = String(formData.get("code") ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    return {
      error: t("web.action.admin.mfa.invalidCode"),
    };
  }
  const r = await verifyAdminTotpEnrollment(code);
  if (!r.ok) return { error: r.error ?? t("web.action.admin.mfa.incorrectCode") };
  const user = await getAuthUser();
  if (user) await setAdminStepUp(user.id);
  return { verified: true };
}
