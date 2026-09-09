import { test } from "@playwright/test";

// Shared env skip-guard for the E2E specs. The suite assumes a real Postgres
// (Neon/local) + R2 stack is reachable; PR builds without it must skip
// gracefully rather than fail. Extracted verbatim from happy-path.spec.ts /
// cancel-reschedule.spec.ts so every spec gates identically.

export const REQUIRED_ENV = ["DATABASE_URL", "DIRECT_URL", "APP_URL", "SESSION_SECRET"] as const;

export const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);

// Apply the standard top-level skip guards for a spec file. Pass
// `extended: true` for journeys gated on E2E_EXTENDED=1 (the promote-gate flag
// the e2e.yml job sets) — they self-skip on an ad-hoc local `pnpm test:e2e` so
// that stays green; run them with `E2E_EXTENDED=1 pnpm test:e2e`.
export function applyE2ESkipGuards(opts: { extended?: boolean } = {}): void {
  test.skip(missingEnv.length > 0, `e2e env not configured: missing ${missingEnv.join(", ")}`);
  if (opts.extended) {
    test.skip(
      process.env.E2E_EXTENDED !== "1",
      "extended journeys are gated on E2E_EXTENDED=1 until their selectors are validated against a live stack",
    );
  }
}
