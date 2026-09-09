import { createHash, randomInt } from "node:crypto";
import type { Page } from "@playwright/test";
import { getPrisma } from "./prisma";

// D-40 — better-auth E2E sign-in helpers. Replaces the old GoTrue
// magic-link/admin.generateLink approach (deleted along with
// /api/auth/callback and the Supabase auth model itself). Mirrors
// src/lib/auth/server-otp.ts, which Playwright's CJS test loader can't
// import directly (see prisma.ts) — the identifier/hash format is
// reverse-engineered from better-auth's own emailOTP plugin, version-pinned,
// and covered by tests/auth/server-otp.test.ts in the main suite.
//
// Plants a verification row directly (no email round trip needed since we
// choose the plaintext code ourselves).
//
// Web sign-in drives the REAL /sign-in FORM rather than POSTing straight to
// better-auth's own /api/auth/sign-in/email-otp — that raw HTTP path 500s in
// this exact Next.js 15.5.15 / local-Supabase-stack combo (a
// Sentry-instrumentation crash masks the real error; preview's identical
// production build signs in fine via the same form, and the direct
// auth.api.signInEmailOTP() function call below — no HTTP hop — also works,
// so the bug is isolated to that one raw HTTP path). Driving the
// UI is also more E2E-faithful: it exercises the real user journey, not just
// the API.

function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("base64url");
}

// Blocks until the REAL send's verification row exists, i.e. until
// auth.api.sendVerificationOTP has actually COMMITTED its write.
//
// Why this is needed (issue #633): the caller advances past
// `codeInput.waitFor()` as soon as the UI shows the code step, and the form
// flips step from useActionState — which can happen BEFORE the server action's
// write lands. Planting on that signal is a race: if the real send commits
// afterwards, it overwrites our row, the code we then type is invalid, and
// sign-in silently never navigates. That surfaced as a 30s
// `page.waitForURL` timeout at the bottom of signInAsViaOtp, three times
// across two runs, and took the promote gate red once (both attempts of
// subscription-and-rails "Free over-cap"). It was never a slow-app problem, so
// no timeout bump would have fixed it.
//
// Observing the row makes the ordering a fact rather than an assumption: once
// it exists the real send is done writing, so a plant issued after it is
// guaranteed to be the row still standing at submit time.
async function waitForRealSendToCommit(identifier: string, timeoutMs = 15_000): Promise<boolean> {
  const prisma = getPrisma();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.verification.findFirst({
      where: { identifier },
      select: { id: true },
    });
    if (row) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function plantSignInOtp(email: string): Promise<string> {
  const prisma = getPrisma();
  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const identifier = `sign-in-otp-${email.toLowerCase()}`;

  // Deliberately NOT fatal when it times out: falling through still plants,
  // which is exactly the old (racy) behaviour — so a send that legitimately
  // writes no row can't turn a previously-passing spec into a hard failure
  // here. The real assertion stays where it belongs, on the navigation.
  await waitForRealSendToCommit(identifier);

  // Safe to delete-then-create now rather than upsert: the only writer that
  // could interleave is the real send, and we just observed it finish.
  await prisma.verification.deleteMany({ where: { identifier } });
  await prisma.verification.create({
    data: {
      identifier,
      value: `${hashOtp(otp)}:0`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  return otp;
}

// Signs in as `email` by driving the real /sign-in form (see rationale
// above), then waits for the resulting redirect to `next`.
//
// Plants the OTP AFTER the real send has COMMITTED, not merely after clicking
// "send code": the click triggers the REAL requestSignInCodeAction ->
// auth.api.sendVerificationOTP, which generates its own random code and
// overwrites the same `sign-in-otp-<email>` verification row. Planting first
// just gets immediately stomped by that real send (we never see the emailed
// code — delivery is stubbed in this environment). Ordering against the UI
// alone was still racy; see waitForRealSendToCommit above.
export async function signInAsViaOtp(page: Page, email: string, next: string): Promise<void> {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel(/correo/i).fill(email);
  await page.getByRole("button", { name: /enviarme un código/i }).click();
  const codeInput = page.getByLabel(/código/i);
  // Explicit short timeout: if the send-code request errors (e.g. hits the
  // per-email rate limit — see E2E_RATE_LIMIT_BYPASS in env.ts) the form
  // stays on the email step forever, and this would otherwise burn the
  // whole test's timeout before failing.
  await codeInput.waitFor({ timeout: 30_000 });
  const otp = await plantSignInOtp(email);
  // No explicit "Entrar" click after this fill — OtpInput auto-submits the
  // form on the 6th digit (its onComplete -> requestSubmit), so filling the
  // code IS the submit. The click that used to be here could never land: by
  // the time it looked, the button had already relabelled itself to
  // "Verificando…" (or the page had navigated away), so `/entrar/i` matched
  // nothing and every web sign-in test hung until its own timeout killed it.
  // Deleted rather than made conditional — a submit that fires twice is a
  // worse bug than one that fires once, and the auto-submit is the real user
  // journey. Same class of bug as the Maestro post-auto-submit tap CLAUDE.md
  // warns about; this is its web twin.
  await codeInput.fill(otp);
  const escaped = next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.waitForURL(new RegExp(escaped), { timeout: 30_000 });
}

// A bearer-session minter lived here, for the three API-E2E specs that drove
// that surface without a browser. Route, specs and helper are all deleted.
// `signInAsViaOtp` above is unaffected — it plants an OTP and drives
// better-auth's own endpoint through the browser, which is how every remaining
// spec signs in.
