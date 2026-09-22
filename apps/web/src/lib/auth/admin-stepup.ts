import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { serverEnv, isProductionDeployment } from "@/lib/env";

// Per-session admin MFA step-up proof (security audit H-1).
//
// The admin gate (lib/admin.ts) used to treat the persistent
// `user.twoFactorEnabled` ENROLMENT flag as if it were proof that a second
// factor had been presented. But the only sign-in rail is passwordless
// email-OTP, and better-auth's two-factor plugin never injects a TOTP
// challenge into that rail — so an attacker who reads an admin's email inbox
// could sign in and satisfy the gate WITHOUT ever entering a TOTP code,
// reducing "mandatory MFA" to a single factor.
//
// This module binds AAL2 to the SESSION instead: after a fresh TOTP verify on
// /admin/security, we set a short-lived, HMAC-signed cookie; requireAdmin()
// requires a valid one. The proof is bound to the auth user id (recomputed at
// verify time from the live session, never trusted from the cookie) and
// expires, forcing a periodic re-challenge. It is deliberately independent of
// the better-auth session cookie so it cannot be minted by session presence
// alone.

export const ADMIN_STEPUP_COOKIE = "admin_stepup";

// How long a single TOTP step-up remains valid before requireAdmin() forces a
// fresh challenge. Short enough that a stolen session goes stale quickly,
// long enough that an admin isn't re-prompted mid-task.
export const ADMIN_STEPUP_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function signingSecret(): string {
  // SESSION_SECRET (>=16 chars, always present) — reused as the HMAC key for
  // capability tokens elsewhere. Distinct purpose from BETTER_AUTH_SECRET.
  return serverEnv().SESSION_SECRET;
}

function sign(userId: string, expMs: number): string {
  return createHmac("sha256", signingSecret()).update(`${userId}.${expMs}`).digest("base64url");
}

// Cookie value format: `<expEpochMs>.<hmac>`. The user id is NOT stored in the
// cookie — it is supplied by the live session at verify time and folded into
// the HMAC, so a proof minted for one account can't be replayed for another.
export function mintStepUpValue(userId: string, nowMs: number): string {
  const expMs = nowMs + ADMIN_STEPUP_TTL_MS;
  return `${expMs}.${sign(userId, expMs)}`;
}

export function isStepUpValueValid(
  value: string | undefined,
  userId: string,
  nowMs: number,
): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expRaw = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expMs = Number(expRaw);
  if (!Number.isFinite(expMs) || expMs <= nowMs) return false;
  const expected = sign(userId, expMs);
  // Constant-time compare; length pre-check avoids timingSafeEqual throwing.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Set the step-up proof cookie for the current response. Callable only from a
// Server Action / Route Handler (where cookies().set is allowed) — i.e. the
// admin TOTP verify actions.
export async function setAdminStepUp(userId: string): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_STEPUP_COOKIE, mintStepUpValue(userId, Date.now()), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProductionDeployment(),
    path: "/",
    maxAge: Math.floor(ADMIN_STEPUP_TTL_MS / 1000),
  });
}

// Read-only check usable from Server Components (the admin gate). Returns true
// only when the current session holds a fresh, correctly-signed proof.
export async function hasValidAdminStepUp(userId: string): Promise<boolean> {
  try {
    const store = await cookies();
    return isStepUpValueValid(store.get(ADMIN_STEPUP_COOKIE)?.value, userId, Date.now());
  } catch {
    // No request cookie context available — fail closed.
    return false;
  }
}

export async function clearAdminStepUp(): Promise<void> {
  try {
    const store = await cookies();
    store.delete(ADMIN_STEPUP_COOKIE);
  } catch {
    // No cookie context — nothing to clear.
  }
}
