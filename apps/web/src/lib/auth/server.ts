import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { emailOTP, twoFactor, bearer, admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/prisma";
import { serverEnv, isProductionDeployment } from "@/lib/env";
import { sendBetterAuthEmailOtp } from "@/lib/auth/email-otp-delivery";
import { trackTeacherSignIn } from "@/lib/auth/sign-in-analytics";

// better-auth (D-40) — the single source of truth for authentication, replacing
// Supabase Auth (GoTrue). Passwordless email-OTP only; HTTP-only cookie sessions
// on web and bearer tokens on mobile, both backed by the one `session` table.
// Plan: docs/features/authentication.md.
//
// This is a clean hard-cut (no feature flag): once the seam in lib/auth.ts is
// rewired onto this instance, GoTrue is gone.
//
// Construction is LAZY (deferred to first real use via the Proxy below), not
// just secret-tolerant: many tests import `@/lib/auth` (the seam) only to
// partially mock a couple of its exports (`vi.mock("@/lib/auth", async
// (importActual) => ...)`), which transitively re-imports this module without
// ever calling `serverEnv()` in their setup. Building the instance eagerly at
// module-eval time would make importing the seam require the full server env
// even when nothing here is ever actually invoked.

// The accepted audiences for a Google ID token, in better-auth's own shape.
//
// better-auth's google provider takes `clientId: string | string[]`, where the
// array form means "any of these is an acceptable `aud`" and the FIRST entry is
// the client the browser redirect flow uses (its getPrimaryClientId). One
// provider therefore covers three token sources: the web redirect and the
// Android native SDK both use the web client id, while the iOS native SDK mints
// its token for the iOS client.
//
// Order is load-bearing — the web client id must stay first, or the browser
// flow would start using a native client id that has no secret and no
// registered redirect URI. Returns the bare string when there's nothing extra
// to accept, so the common case produces exactly the config it always had.
function createAuth() {
  const env = serverEnv();
  const configuredSecret = env.BETTER_AUTH_SECRET;
  // Google Sign-In (login) — only registered when both credentials are present
  // (hasGoogleAuthCreds). Left undefined otherwise so the /sign-in/social +
  // /callback/google endpoints stay unmounted and email-OTP is the sole rail on
  // an unconfigured env. SEPARATE OAuth client from Calendar busy-import
  // (GOOGLE_OAUTH_*) — see env.ts.
  const socialProviders =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : undefined;
  return {
    configuredSecret,
    instance: betterAuth({
      // Also the TOTP issuer label authenticator apps show (twoFactor's
      // totpOptions has no separate issuer set below, so it falls back to
      // this) — distinguish preview from production the same way the mobile
      // app's display name does (app.config.js's IS_PREVIEW ? 'AP Preview'),
      // so an admin's authenticator app doesn't show two identical
      // "SpiralClass" entries for two different accounts/secrets.
      appName: isProductionDeployment() ? "SpiralClass" : "AP Preview",
      baseURL: env.BETTER_AUTH_URL ?? env.APP_URL,
      // `secret` falls back to a clearly-invalid placeholder so a pre-cutover
      // deploy without the secret degrades cleanly. betterAuthConfigured() is
      // the runtime gate the routes/seam check before trusting better-auth, so
      // a placeholder can never silently sign real users in.
      secret: configuredSecret ?? "better-auth-unconfigured-placeholder-secret-do-not-use",
      database: prismaAdapter(prisma, { provider: "postgresql" }),
      // Preserve existing user UUIDs. `generateId: "uuid"` makes better-auth mint real
      // UUIDs for NEW users (matching our `@db.Uuid` columns + FKs); the historical
      // backfill inserts rows directly with their old ids, bypassing generateId.
      advanced: {
        database: { generateId: "uuid" },
      },
      // Fully passwordless — no email/password provider at all.
      emailAndPassword: { enabled: false },
      // Google Sign-In (login). Undefined (omitted) when unconfigured — see above.
      ...(socialProviders ? { socialProviders } : {}),
      // Account linking: when a Google sign-in's email matches an existing
      // email-OTP User, link the Google Account to that user (one account,
      // not a duplicate that would collide on User.email's unique index)
      // WITHOUT a re-verification step — safe because Google asserts a verified
      // email and is listed as trusted here. allowDifferentEmails stays at its
      // default (false): linking only ever happens on an exact verified-email
      // match, never across mismatched addresses.
      account: {
        accountLinking: { enabled: true, trustedProviders: ["google"] },
      },
      // Signed, edge-safe cache of {session, user} in a second cookie so
      // middleware (src/lib/auth/middleware.ts) can read a best-effort
      // `user.email` (for the isSuperuser destination on the /sign-in bounce)
      // without a DB round trip. Purely optimistic: a stale/expired cache
      // just falls back to a generic destination — the authoritative check is
      // always auth.api.getSession() at the page/action layer. We're on
      // 1.6.23, well past the cookie-cache/2FA advisory fixed in 1.4.9
      // (GHSA-xg6x-h9c9-2m83).
      session: { cookieCache: { enabled: true, maxAge: 60 } },
      // Fire a server-side `teacher_signed_in` on each new session (returning
      // sign-in), for web-cookie AND mobile-bearer sessions alike. Best-effort:
      // trackTeacherSignIn swallows every error so analytics can never block or
      // break authentication. See lib/auth/sign-in-analytics.ts.
      databaseHooks: {
        session: {
          create: {
            after: async (session) => {
              await trackTeacherSignIn(session.userId);
            },
          },
        },
      },
      plugins: [
        emailOTP({
          otpLength: 6,
          expiresIn: 300,
          allowedAttempts: 3,
          // Store only a hash of each OTP at rest.
          storeOTP: "hashed",
          // Verified email-change for teachers/students (lib/teachers/email-change.ts,
          // lib/students/email-change.ts): requestEmailChangeEmailOTP mints + sends a
          // code to the NEW address (via sendVerificationOTP below), changeEmailEmailOTP
          // verifies it and flips User.email. verifyCurrentEmail stays off — the caller
          // is already an authenticated session, so re-proving the OLD address adds no
          // security value here (unlike a first-time signup).
          changeEmail: { enabled: true },
          async sendVerificationOTP({ email, otp, type }) {
            // Deliver the code via the existing Resend rail (code-only — magic-link
            // delivery is dropped). Throws on send failure so better-auth surfaces
            // the error rather than silently dropping the code.
            await sendBetterAuthEmailOtp({ email, otp, type });
          },
        }),
        // Second factor: admin-only in app logic (lib/admin.ts gates on
        // role + user.twoFactorEnabled). Passwordless (D-40) — enable/verify/disable
        // never require a password since emailAndPassword is disabled entirely.
        // trustDevice is left off by never passing `trustDevice: true` from our
        // own calls (lib/auth/admin-mfa.ts).
        //
        // ⚠️ allowPasswordless must be set at BOTH levels: the top-level flag
        // gates the plugin's own /two-factor/enable + /two-factor/disable
        // endpoints' password requirement; totpOptions.allowPasswordless only
        // covers the TOTP submodule's own verify flow. Missing the top-level
        // one means enableTwoFactor's body schema requires `password`, which
        // we never have — enrollAdminTotp() 400s with "Invalid password".
        twoFactor({ allowPasswordless: true, totpOptions: { allowPasswordless: true } }),
        // Mobile bearer-token sessions share the same `session` table as web cookies.
        bearer(),
        // Cross-user session revocation (revokeUserSessions) for the account-deletion job.
        admin(),
        // MUST be last — lets sign-in called from a server action set the cookie.
        nextCookies(),
      ],
    }),
  };
}

type LazyAuth = ReturnType<typeof createAuth>["instance"];

let cached: ReturnType<typeof createAuth> | undefined;
function resolved(): ReturnType<typeof createAuth> {
  if (!cached) cached = createAuth();
  return cached;
}

// Lazily-initialized: property access on `auth` (e.g. `auth.api.getSession`)
// triggers createAuth() on first real use, not on import.
export const auth: LazyAuth = new Proxy({} as LazyAuth, {
  get(_target, prop, receiver) {
    return Reflect.get(resolved().instance, prop, receiver);
  },
  // `has` MUST forward to the real instance too. better-auth's toNextJsHandler
  // branches on `"handler" in auth` to distinguish an instance from a bare
  // handler function; without this trap the `in` operator hits the empty Proxy
  // target, returns false, and EVERY /api/auth/* request falls to `auth(request)`
  // on a non-callable Proxy → "auth is not a function" (500 on sign-in).
  has(_target, prop) {
    return Reflect.has(resolved().instance, prop);
  },
});

export type Auth = LazyAuth;
export type Session = Auth["$Infer"]["Session"];

// Runtime gate: true only when a real signing secret is configured. Routes and
// the session seam check this before trusting better-auth, so a pre-cutover
// deploy without the secret degrades cleanly instead of minting sessions under a
// placeholder key.
export function betterAuthConfigured(): boolean {
  return Boolean(resolved().configuredSecret);
}
