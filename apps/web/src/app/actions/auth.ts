"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { signUpSchema, signInSchema } from "@/lib/validators";
import { getPreferredLocale } from "@/lib/i18n";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { finalizeSignIn } from "@/app/actions/session";
import { safeNextPath } from "@/lib/auth/safe-next";
import { logger } from "@/lib/logger";
import { allowRateLimitBypass } from "@/lib/env";

const log = logger({ surface: "auth" });

export type ActionState = { error?: string; ok?: boolean; retryAfterMs?: number } | undefined;

// Passwordless email-OTP auth (D-40) — a single rail for sign-in and sign-up
// on better-auth's emailOTP plugin (disableSignUp: false): any email that
// verifies its 6-digit code gets a User row if it doesn't have one yet.
// /sign-up additionally collects a display name, carried through to
// verifySignInCodeAction so it lands on the row if this turns out to be a
// brand-new account. Anti-enumeration comes for free — better-auth always
// attempts the send regardless of whether the email is known.
//
// The bare User row is harmless on its own — D-56 gates the APP-LEVEL role
// provisioning (Teacher lazy-create) on an explicit `intent` field the form
// sends, not on whether the email happens to be unmatched: /sign-in never
// mints a Teacher for a brand-new identity, only /sign-up does.

const tooMany = (en: boolean) =>
  en
    ? "Too many attempts. Try again in a minute."
    : "Demasiados intentos. Intenta de nuevo en un minuto.";

export async function requestSignInCodeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const bypass = allowRateLimitBypass();

  const ip = await clientIp();
  const rl = bypass
    ? { ok: true, retryAfterMs: 0 }
    : await rateLimit(ip, { scope: "sign-in", limit: 8, windowMs: 60_000 });
  if (!rl.ok) return { error: tooMany(en), retryAfterMs: rl.retryAfterMs };

  const parsed = signInSchema(locale).safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? (en ? "Invalid email" : "Correo inválido") };
  }

  // Per-email window (on top of the per-IP one above) thwarts repeated
  // "resend" taps and targeted mailbox flooding from rotating IPs — mirrors
  // the mobile request-otp route's mobile-request-otp-email scope.
  const emailRl = bypass
    ? { ok: true, retryAfterMs: 0 }
    : await rateLimit(parsed.data.email.toLowerCase(), {
        scope: "sign-in-email",
        limit: 4,
        windowMs: 5 * 60_000,
      });
  if (!emailRl.ok) return { error: tooMany(en), retryAfterMs: emailRl.retryAfterMs };

  try {
    await auth.api.sendVerificationOTP({
      body: { email: parsed.data.email, type: "sign-in" },
      headers: await headers(),
    });
  } catch (err) {
    // Logged only — always return ok so the response doesn't leak whether the
    // address has an account.
    log.warn("sign-in code send failed", { error: err });
  }
  return { ok: true };
}

export async function requestTeacherSignupCodeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const ip = await clientIp();
  const rl = await rateLimit(ip, { scope: "sign-up", limit: 6, windowMs: 60_000 });
  if (!rl.ok) return { error: tooMany(en), retryAfterMs: rl.retryAfterMs };

  const parsed = signUpSchema(locale).safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos") };
  }

  // Per-email window — see requestSignInCodeAction for the rationale.
  const emailRl = await rateLimit(parsed.data.email.toLowerCase(), {
    scope: "sign-up-email",
    limit: 4,
    windowMs: 5 * 60_000,
  });
  if (!emailRl.ok) return { error: tooMany(en), retryAfterMs: emailRl.retryAfterMs };

  try {
    await auth.api.sendVerificationOTP({
      body: { email: parsed.data.email, type: "sign-in" },
      headers: await headers(),
    });
  } catch (err) {
    log.warn("signup code send failed", { error: err });
  }
  return { ok: true };
}

export async function verifySignInCodeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const ip = await clientIp();
  const rl = allowRateLimitBypass()
    ? { ok: true, retryAfterMs: 0 }
    : await rateLimit(ip, { scope: "verify-web-code", limit: 8, windowMs: 60_000 });
  if (!rl.ok) return { error: tooMany(en) };

  const email = formData.get("email");
  const code = formData.get("code");
  const nameRaw = formData.get("name");
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : undefined;
  const next = safeNextPath(formData.get("next"));
  // Which form posted here (D-56) — only "sign-up" may lazy-create a Teacher
  // for a brand-new identity in finalizeSignIn. Defaults to the safer
  // "sign-in" if the field is missing rather than trusting an unexpected value.
  const intent = formData.get("intent") === "sign-up" ? "sign-up" : "sign-in";

  if (typeof email !== "string" || typeof code !== "string" || !email || !code) {
    return { error: en ? "Missing email or code." : "Falta correo o código." };
  }

  let signedInUser: { id: string; email: string } | null = null;
  try {
    // `name` is only applied by better-auth when this email has no User row
    // yet — an existing account keeps its current name.
    const result = await auth.api.signInEmailOTP({
      body: { email, otp: code.trim(), name },
      headers: await headers(),
    });
    signedInUser = result.user;
  } catch (err) {
    log.warn("verify sign-in code failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      error: en
        ? "Invalid or expired code. Request a new one."
        : "Código inválido o expirado. Solicita uno nuevo.",
    };
  }

  // Pass the user signInEmailOTP just resolved directly — NOT via
  // getAuthUser()/headers(), which in this same request still reflect the
  // incoming request from before the session cookie was set. See
  // finalizeSignIn's own comment (app/actions/session.ts).
  const dest = await finalizeSignIn(next, signedInUser, intent);
  redirect(dest);
}

export async function signOutAction() {
  await auth.api.signOut({ headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/");
}
