import { randomInt, createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth/server";
import { logger } from "@/lib/logger";

const log = logger({ surface: "server-otp" });

// Server-trusted OTP minting (D-40) — for flows where WE have already
// verified the recipient's identity out-of-band (a WhatsApp notification
// link only the right phone number receives; a superadmin's audited "sign in
// as") and want to hand them a real sign-in credential without emailing a
// code and waiting for them to type it back.
//
// Mechanism: plant a verification row in the exact shape better-auth's
// emailOTP plugin expects for a "sign-in" OTP, then let its OWN public,
// documented auth.api.signInEmailOTP (or a later manual entry, for the
// mint-a-code-for-later case) do 100% of the real verification, session, and
// cookie work — we never hand-rol session/cookie creation.
//
// ⚠️ The identifier/hash format (`sign-in-otp-<email>`, SHA-256 → base64url,
// `<hash>:<attempts>`) is copied from better-auth's own source
// (better-auth/dist/plugins/email-otp/{utils,otp-token}.mjs) — an internal
// implementation detail, not a public contract (that subpath isn't in the
// package's public `exports` map, so it can't even be imported directly to
// assert against). Pinned to better-auth 1.6.23; tests/auth/server-otp.test.ts
// pins the exact hash/identifier shape this module produces, so a change here
// fails loudly in CI. It does NOT round-trip through the real
// auth.api.signInEmailOTP (that needs a live DB) — the preview pass
// (docs/features/authentication.md) is what proves a planted
// row actually verifies end-to-end before this ships to production.

const OTP_IDENTIFIER_PREFIX = "sign-in-otp-";

function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("base64url");
}

function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

async function plantOtp(email: string, ttlSeconds: number): Promise<string> {
  const otp = generateOtp();
  const identifier = `${OTP_IDENTIFIER_PREFIX}${email.toLowerCase()}`;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  // Clear any pending real (emailed) code for this identifier first — planting
  // one here must not leave two live verification rows racing each other.
  await prisma.verification.deleteMany({ where: { identifier } });
  await prisma.verification.create({
    data: { identifier, value: `${hashOtp(otp)}:0`, expiresAt },
  });
  return otp;
}

// Mint a plaintext code for later redemption through the normal
// sign-in-with-code screen. Short TTL — long enough for a human to read and
// type it, not for a leaked code to be useful later.
//
// ⚠️ NO PRODUCTION CALLER since the deletion of the preview test seam
// (/api/test/mint-otp); the magic-link redirect routes use the session variant
// below. It is KEPT deliberately, not overlooked: `plantOtp` is not exported,
// so this is the only seam through which tests/auth/server-otp.test.ts can
// assert that the planted row's hash matches better-auth's OWN hash algorithm.
// That test is what catches better-auth changing its hashing and silently
// breaking magic-link auto-login in production. Deleting this deletes that.
export async function mintServerSideOtpCode(email: string, ttlSeconds = 10 * 60): Promise<string> {
  return plantOtp(email, ttlSeconds);
}

// Mint a code AND immediately consume it via better-auth's own
// signInEmailOTP — establishing a real session/cookie through the same
// tested code path a typed code takes. Used by server-trusted auto-login
// redirects (notification action links) where nothing needs to be shown to
// anyone; the whole plant-and-consume happens in one request.
export async function mintServerSideOtpSession(
  email: string,
  headers: Headers,
): Promise<Awaited<ReturnType<typeof auth.api.signInEmailOTP>>> {
  const otp = await plantOtp(email, 60);
  try {
    return await auth.api.signInEmailOTP({ body: { email, otp }, headers });
  } catch (err) {
    log.error("mintServerSideOtpSession: signInEmailOTP failed", err, { email });
    throw err;
  }
}
