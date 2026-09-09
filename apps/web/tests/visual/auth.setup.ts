import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { signInAsViaOtp } from "../e2e/_helpers/better-auth";
import { clearAdminEnrolment, hasStoredAdminSecret, satisfyAdminStepUp } from "./admin-mfa";
import { missingEnv } from "../e2e/_helpers/env";
import { LANDING_AFTER_SIGN_IN, SESSION_EMAILS, statePath, type AuthedTier } from "./session";

/**
 * Signs in once per audience and saves the session, so the capture sweep does
 * not.
 *
 * The sweep is 97 routes across 12 viewport/theme projects — roughly 1,200
 * page loads. Driving the real OTP form for each one costs about eight seconds
 * and would turn a twenty-five minute run into a three-hour one, which is the
 * difference between a check somebody runs and a check somebody skips.
 *
 * It drives the REAL sign-in form rather than posting to better-auth directly,
 * because that raw HTTP path 500s in this Next/stack combination — see the
 * note at the top of tests/e2e/_helpers/better-auth.ts. Reusing that helper
 * means this file inherits the fix rather than rediscovering it.
 *
 * TWO ASSERTIONS GUARD A FAILURE THAT IS OTHERWISE SILENT. The first sweep
 * reported 1,167 passed and had photographed the sign-in page 1,000 times: a
 * screenshot of a redirect is still a successful screenshot. The cause was
 * passing "/" as the post-sign-in target — the helper escapes it into the
 * regex `/`, which matches every URL, so the wait succeeded on the sign-in page
 * itself and the run never noticed it had no session.
 *
 * So each tier now lands on a route that REQUIRES its session, and the saved
 * state is checked for a session cookie before it is written. Either failing
 * stops the run here, where the message names the problem, rather than 25
 * minutes later in a gallery that looks plausible until someone opens it.
 */

const TIERS: AuthedTier[] = ["teacher", "student", "admin"];

/** better-auth names its cookie `better-auth.session_token`, with a
 * `__Secure-` prefix over HTTPS. Match on the shape rather than the exact
 * string so a prefix or a version bump doesn't silently disarm the check. */
const SESSION_COOKIE = /session/i;

for (const tier of TIERS) {
  setup(`authenticate as ${tier}`, async ({ page }) => {
    setup.skip(
      missingEnv.length > 0,
      `visual auth needs a database: missing ${missingEnv.join(", ")}`,
    );
    const email = SESSION_EMAILS[tier];
    setup.skip(!email, `no ${tier} account configured — set VISUAL_${tier.toUpperCase()}_EMAIL`);

    // If the database has an enrolment the harness has no authenticator for —
    // .auth cleared without resetting the database — drop it now, BEFORE the
    // session exists. Doing it afterwards is invisible to the server, which
    // reads twoFactorEnabled from the cached session cookie.
    if (tier === "admin" && !hasStoredAdminSecret()) await clearAdminEnrolment(email as string);

    // A route this audience cannot reach signed out, so arriving there is
    // itself the proof the session exists.
    const landing = LANDING_AFTER_SIGN_IN[tier];
    await signInAsViaOtp(page, email as string, landing);
    await expect(
      page,
      `sign-in as ${email} did not land on ${landing} — no session was established`,
    ).toHaveURL(new RegExp(landing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // The admin console needs a second factor on top of the session — see
    // admin-mfa.ts. Done before the state is saved so the step-up cookie is
    // part of it.
    if (tier === "admin") await satisfyAdminStepUp(page);

    const state = await page.context().storageState();
    const cookies = state.cookies.map((c) => c.name);
    expect(
      cookies.some((name) => SESSION_COOKIE.test(name)),
      `no session cookie after signing in as ${email}; got: ${cookies.join(", ") || "none"}`,
    ).toBe(true);

    // Sign-in happens in es-MX (see the config's note), and getPreferredLocale
    // reads a `locale` cookie ahead of Accept-Language — so keeping that cookie
    // would render the entire English baseline in Spanish, silently and
    // consistently enough to look intentional. Dropping it puts locale
    // resolution back on the Accept-Language header the capture projects set.
    state.cookies = state.cookies.filter((cookie) => cookie.name !== "locale");

    const file = statePath(tier);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  });
}
