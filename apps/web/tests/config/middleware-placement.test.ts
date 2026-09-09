import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// Locks the ONE thing about middleware that fails silently.
//
// This app uses a `src/` directory, so Next.js loads middleware from exactly
// one path: apps/web/src/middleware.ts. A copy anywhere else — most temptingly
// the project root, which is where every Next tutorial without `src/` puts it —
// type-checks, lints, builds, and deploys perfectly green while never being
// invoked. What goes dormant with it is not cosmetic: the CSP header, the
// better-auth session-cookie gate, the auth redirects, and ?ref= attribution.
//
// No other check in this repo would notice. `tsc` sees a valid module either
// way; ESLint has no opinion on file location; the unit suite never imports it;
// even a production deploy comes up healthy, just unauthenticated. The failure
// surfaces as a security incident, not a build error.
//
// So: assert the file is where Next will actually look, assert nothing is
// squatting at the paths that would *look* right to a future reader, and assert
// the module still exports the two symbols Next needs to wire it up. The
// build-time counterpart — proving it reached the middleware manifest — lives in
// apps/web/scripts/check-build-output.mjs, which runs after `next build` in
// integration.yml. This test is the cheap half that runs on every PR.

const WEB_ROOT = resolve(REPO_ROOT, "apps/web");

/** The only path Next.js loads middleware from in a `src/`-directory app. */
const LOADED_PATH = "src/middleware.ts";

/**
 * Paths that would be silently ignored. Each is a plausible place for someone
 * to "tidy" the file to, and each produces a green build with no middleware.
 */
const DECOY_PATHS = [
  "middleware.ts",
  "middleware.js",
  "src/middleware.js",
  "src/app/middleware.ts",
  "src/app/middleware.js",
];

describe("middleware placement", () => {
  it("lives at the one path Next.js loads it from", () => {
    expect(
      existsSync(resolve(WEB_ROOT, LOADED_PATH)),
      `${LOADED_PATH} is missing. With a src/ directory Next.js loads middleware from ` +
        `there and nowhere else — if it moved, CSP/auth/session are dormant in production.`,
    ).toBe(true);
  });

  it.each(DECOY_PATHS)("has no silently-ignored copy at %s", (decoy) => {
    expect(
      existsSync(resolve(WEB_ROOT, decoy)),
      `Found middleware at ${decoy}. Next.js will NOT load it (this app uses src/), ` +
        `so it compiles and deploys green while CSP, the better-auth session gate, ` +
        `auth redirects and ?ref= attribution never run. Move it to ${LOADED_PATH}.`,
    ).toBe(false);
  });

  it("still exports the middleware function and a matcher config", () => {
    const source = readFileSync(resolve(WEB_ROOT, LOADED_PATH), "utf8");

    // Next accepts `export function middleware` or `export default`. Either is
    // fine; having neither means the file is loaded and does nothing.
    expect(
      /export\s+(async\s+)?function\s+middleware\b/.test(source) ||
        /export\s+default\b/.test(source),
      "middleware.ts exports neither a `middleware` function nor a default export — " +
        "Next.js has nothing to invoke.",
    ).toBe(true);

    // A `config.matcher` that stopped matching real routes is the same outage
    // with a different cause, so assert the export survives. Its contents are
    // deliberately not asserted — the matcher is tuned regularly (health probe,
    // Sentry tunnel, static assets) and pinning it here would just be a second
    // place to edit.
    expect(
      /export\s+const\s+config\b/.test(source),
      "middleware.ts no longer exports `config` — without a matcher Next falls back to " +
        "running middleware on every request, including _next/static.",
    ).toBe(true);
  });
});
