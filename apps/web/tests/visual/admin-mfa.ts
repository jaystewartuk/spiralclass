import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { expect, type Page } from "@playwright/test";
import { getPrisma } from "../e2e/_helpers/prisma";
import { ADMIN_STEPUP_COOKIE } from "./session";

/**
 * Satisfies the admin MFA gate so the admin console can be photographed.
 *
 * WHY THIS EXISTS. requireAdmin() needs three things, not one: an `AdminUser`
 * row, `user.twoFactorEnabled`, and a fresh HMAC-signed `admin_stepup` cookie
 * proving a TOTP verify within the last 12 hours. That third requirement is
 * security audit finding H-1 — the only sign-in rail is passwordless email
 * OTP, and better-auth never injects a TOTP challenge into it, so treating the
 * persistent enrolment flag as proof would have let anyone with an admin's
 * inbox satisfy "mandatory MFA" with a single factor. See
 * src/lib/auth/admin-stepup.ts.
 *
 * WHAT THIS IS NOT. It is not a bypass, and it must never become one. The
 * harness enrols its OWN authenticator on the throwaway capture database and
 * computes real RFC 6238 codes from the secret it was given — exactly what a
 * phone would do. Nothing here weakens the gate: without the secret this code
 * gets you nowhere, and the secret only exists on a disposable Neon branch.
 * The codes are generated with `@better-auth/utils/otp`, the same primitive
 * better-auth verifies with, so they match by construction rather than by
 * a reimplementation that could drift.
 *
 * If a future change makes the admin console reachable without a second
 * factor, this file should start failing. That is the intended behaviour —
 * do not "fix" it by relaxing the assertion at the bottom.
 */

/** The panel's code field, present in both enrolled states and absent in the
 * not-yet-enrolled one — the discriminator the state machine turns on. */
const CODE_INPUT = "#code";
/** The manual-entry key, rendered only by a fresh enrolment. */
const SECRET_TEXT = "details p.font-mono";

/** The enrolled secret, kept beside the session states. Gitignored: it is a
 * real authenticator secret, albeit for a disposable database. */
const SECRET_PATH = resolve(__dirname, "../../.auth", "admin-totp.txt");

export function hasStoredAdminSecret(): boolean {
  return readStoredSecret() !== null;
}

function readStoredSecret(): string | null {
  return existsSync(SECRET_PATH) ? readFileSync(SECRET_PATH, "utf8").trim() || null : null;
}

function storeSecret(secret: string): void {
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  writeFileSync(SECRET_PATH, `${secret}\n`);
}

/**
 * Generates the current 6-digit code from the manual-entry key the form shows.
 *
 * The two are not the same string, and conflating them fails silently: better-auth
 * stores a RAW secret and publishes `base32.encode(raw)` as the `secret=` param of
 * the otpauth:// URI, which is what the enrolment panel renders for manual entry.
 * `createOTP()` expects the raw secret. Feeding it the base32 form produces a
 * perfectly well-formed six-digit code that simply never verifies — which is
 * exactly how this failed the first time, with the enrolment panel re-rendering
 * on every retry and no error saying why.
 *
 * The decoded bytes go back through latin1 because the stored secret is an ASCII
 * string, and `createHMAC().sign()` takes a string key rather than a byte array.
 */
async function totpCode(manualEntryKey: string): Promise<string> {
  const raw = Buffer.from(base32.decode(manualEntryKey)).toString("latin1");
  return createOTP(raw).totp();
}

/**
 * Drops the admin's TOTP enrolment so the next sign-in starts a fresh one.
 *
 * better-auth's enable endpoint DOES mint a new secret when called again, but
 * the form never offers it once `alreadyEnrolled` is true — that branch returns
 * a step-up prompt and nothing else. So the row goes directly.
 *
 * MUST run BEFORE signing in, not during the session. better-auth caches the
 * user record — `twoFactorEnabled` included — in the `better-auth.session_data`
 * cookie, so clearing the row mid-session changes nothing the server can see:
 * the panel keeps rendering the step-up prompt off stale cached state until the
 * cookie expires. That is what made this flaky, and it passed on retry only
 * because the retry signed in again and got fresh session data.
 */
export async function clearAdminEnrolment(email: string): Promise<void> {
  const prisma = getPrisma();
  const user = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  expect(user, `no user row for ${email}; is the capture database seeded?`).not.toBeNull();
  await prisma.twoFactor.deleteMany({ where: { userId: user!.id } });
  await prisma.user.update({ where: { id: user!.id }, data: { twoFactorEnabled: false } });
}

/**
 * Waits until the panel is in the not-yet-enrolled state, then starts
 * enrolment and returns the freshly minted manual-entry key.
 *
 * The wait is not decoration. Both the not-enrolled and the already-enrolled
 * states render a `form button[type=submit]`, and the already-enrolled one is
 * DISABLED until six digits are typed — so clicking `.first()` against a page
 * that has not yet re-rendered spends twenty seconds on an element that will
 * never become clickable. That is precisely how this went flaky: the reload
 * after clearing the enrolment raced the server's view of it and matched the
 * step-up form's "Verificar y continuar".
 *
 * The code input is the discriminator: only the not-enrolled state lacks it.
 */
async function beginEnrolment(page: Page): Promise<string> {
  await expect
    .poll(() => page.locator(CODE_INPUT).count(), {
      timeout: 20_000,
      message: "the MFA panel never reached the not-yet-enrolled state",
    })
    .toBe(0);

  await page.locator("form button[type=submit]").first().click();
  await page.locator(CODE_INPUT).waitFor({ timeout: 30_000 });

  const secretEl = page.locator(SECRET_TEXT).first();
  // `attached`, not the default `visible`: the manual-entry key lives inside a
  // <details> the form collapses whenever the QR code renders, so it is present
  // and readable but hidden. textContent() does not care; waitFor() does.
  await secretEl.waitFor({ state: "attached", timeout: 30_000 });
  const secret = ((await secretEl.textContent()) ?? "").trim();
  expect(secret, "enrolment rendered an empty TOTP secret").not.toBe("");
  storeSecret(secret);
  return secret;
}

export async function satisfyAdminStepUp(page: Page): Promise<void> {
  await page.goto("/admin/security");

  // Three states, and the copy is localised, so they are told apart by DOM
  // shape: the code input exists in both the just-enrolled and the
  // already-enrolled states; the manual-entry secret exists only in the first.
  const codeInput = page.locator(CODE_INPUT);
  const secretEl = page.locator(SECRET_TEXT);

  let secret: string | null;
  if ((await codeInput.count()) === 0) {
    secret = await beginEnrolment(page);
  } else if ((await secretEl.count()) > 0) {
    secret = ((await secretEl.first().textContent()) ?? "").trim();
    expect(secret, "enrolment rendered an empty TOTP secret").not.toBe("");
    storeSecret(secret);
  } else {
    // Already enrolled, and a step-up deliberately shows no secret — it
    // re-proves possession rather than re-issuing one.
    secret = readStoredSecret();
    expect(
      secret,
      `the admin is enrolled but the harness has no authenticator for it. The setup ` +
        `clears a stale enrolment BEFORE signing in, so reaching here means that step ` +
        `did not run — check auth.setup.ts.`,
    ).not.toBeNull();
  }

  // Narrowed by the assertions above: every branch either read a secret from the
  // freshly rendered panel or proved a stored one exists.
  const code = await totpCode(secret as string);
  // OtpInput auto-submits on the sixth digit (its onComplete calls
  // requestSubmit), so filling the code IS the submit — the same behaviour
  // documented in tests/e2e/_helpers/better-auth.ts. Clicking afterwards would
  // either miss (the button has relabelled) or double-submit.
  await codeInput.fill(code);

  // The step-up cookie is the only copy-independent proof this worked, and it
  // is the thing requireAdmin() actually reads.
  await expect
    .poll(
      async () => {
        const cookies = await page.context().cookies();
        return cookies.some((c) => c.name === ADMIN_STEPUP_COOKIE);
      },
      {
        timeout: 30_000,
        message:
          "no admin_stepup cookie after submitting a TOTP code — the admin console is still gated",
      },
    )
    .toBe(true);
}
