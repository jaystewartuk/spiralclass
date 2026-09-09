#!/usr/bin/env node
/**
 * Assert things about the BUILT output that no source-level check can see.
 *
 * Typecheck, lint and the unit suite all reason about source. Some of the most
 * expensive failures in this app are invisible there and only become facts at
 * build time — the build succeeds, the deploy is healthy, and the thing that
 * broke is simply absent. Two of those get asserted here:
 *
 *   1. Middleware actually compiled into the manifest.
 *      apps/web/tests/config/middleware-placement.test.ts proves the source file
 *      sits where Next.js looks. This proves Next.js agreed — that CSP, the
 *      better-auth session gate, auth redirects and ?ref= attribution are really
 *      in the artifact about to ship. A misplaced or mis-configured middleware
 *      produces an empty manifest and a perfectly green build.
 *
 *   2. No server-side secret VALUE reached a client bundle.
 *      Next only inlines NEXT_PUBLIC_* into client code, so this cannot happen
 *      by accident through env access alone. It happens when a secret is passed
 *      from a Server Component into a Client Component's props, or read in a
 *      module that later gains a "use client" consumer. The value is then baked
 *      into a static chunk served to every visitor. Nothing in the build warns.
 *      Scanning the emitted chunks for the literal values in the build env is
 *      the only way to know.
 *
 * Runs after `next build` in scripts/ci/integration.sh (was integration.yml
 * until D-129 deleted every workflow in this repo).
 *
 *   node scripts/check-build-output.mjs [.next]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "..");
const distDir = resolve(webRoot, process.argv[2] ?? ".next");

const failures = [];

function fail(message) {
  failures.push(message);
}

/* ------------------------------------------------------------------ *
 * 1. Middleware reached the build
 * ------------------------------------------------------------------ */

function checkMiddlewareCompiled() {
  const manifestPath = join(distDir, "server", "middleware-manifest.json");

  if (!existsSync(manifestPath)) {
    fail(
      `No middleware manifest at ${relative(webRoot, manifestPath)}. Either the build ` +
        `did not complete or Next.js emitted nothing for middleware.`,
    );
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`Could not parse ${relative(webRoot, manifestPath)}: ${error.message}`);
    return;
  }

  // Next has used both shapes across versions: a `middleware` map keyed by
  // route, and a `sortedMiddleware` array. Accept either — the assertion is
  // "something is registered", not "this exact schema".
  const entries = Object.values(manifest.middleware ?? {});
  const sorted = manifest.sortedMiddleware ?? [];

  if (entries.length === 0 && sorted.length === 0) {
    fail(
      `The middleware manifest is EMPTY. src/middleware.ts did not compile into the ` +
        `build, so CSP, the better-auth session gate, auth redirects and ?ref= ` +
        `attribution will all be dormant in this deploy. This is the exact failure a ` +
        `misplaced middleware file produces — see the header comment in src/middleware.ts.`,
    );
    return;
  }

  // A registered middleware with no matchers runs on nothing, which is the same
  // outage reached a different way.
  const withMatchers = entries.filter((entry) => (entry?.matchers ?? []).length > 0);

  if (entries.length > 0 && withMatchers.length === 0) {
    fail(
      `Middleware is registered but has NO matchers — it will not run on any route. ` +
        `Check the \`config.matcher\` export in src/middleware.ts.`,
    );
    return;
  }

  const matcherCount = withMatchers.reduce((sum, entry) => sum + entry.matchers.length, 0);
  console.log(
    `middleware: compiled into the manifest with ${matcherCount} matcher(s). ` +
      `CSP / session gate / auth redirects are in the artifact.`,
  );
}

/* ------------------------------------------------------------------ *
 * 2. No server secret leaked into a client chunk
 * ------------------------------------------------------------------ */

/**
 * Env vars whose VALUE must never appear in a browser bundle.
 *
 * Names, not values, are listed here — the values come from the build
 * environment at run time. A var that is unset in this environment is simply
 * skipped: absence proves nothing either way, and failing on it would make the
 * script unrunnable outside CI.
 */
const SERVER_ONLY_ENV = [
  "DATABASE_URL",
  "DIRECT_URL",
  "SESSION_SECRET",
  "BETTER_AUTH_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_BILLING_WEBHOOK_SECRET",
  "WISE_API_TOKEN",
  "RESEND_API_KEY",
  "OPENAI_API_KEY",
  "LIVEKIT_API_SECRET",
  "R2_SECRET_ACCESS_KEY",
  "INNGEST_SIGNING_KEY",
  "INNGEST_EVENT_KEY",
];

/**
 * Below this length a "secret" is almost certainly a stub or placeholder whose
 * characters would collide with ordinary minified code, producing false
 * positives that train people to ignore this check.
 */
const MIN_SECRET_LENGTH = 16;

function* clientChunks(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* clientChunks(full);
    else if (entry.endsWith(".js")) yield full;
  }
}

function checkNoSecretsInClientBundle() {
  const staticDir = join(distDir, "static");

  if (!existsSync(staticDir)) {
    console.log("no .next/static directory — skipping the client-bundle secret scan.");
    return;
  }

  const secrets = SERVER_ONLY_ENV.map((name) => ({ name, value: process.env[name] })).filter(
    ({ value }) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH,
  );

  if (secrets.length === 0) {
    console.log(
      "no server-only env vars set in this environment — skipping the client-bundle " +
        "secret scan. (Expected locally; in CI the build env supplies them.)",
    );
    return;
  }

  let scanned = 0;
  let leaks = 0;
  for (const chunk of clientChunks(staticDir)) {
    const contents = readFileSync(chunk, "utf8");
    scanned += 1;

    for (const { name, value } of secrets) {
      if (contents.includes(value)) {
        leaks += 1;
        fail(
          `The value of ${name} appears in the client bundle ${relative(webRoot, chunk)}. ` +
            `This chunk is served to every visitor. A server-only secret reaches client ` +
            `code by being passed into a Client Component's props or read in a module a ` +
            `"use client" file imports — find that path and cut it, then rotate ${name}.`,
        );
      }
    }
  }

  if (leaks === 0) {
    console.log(
      `client bundle: scanned ${scanned} chunk(s) for ${secrets.length} server-only secret ` +
        `value(s); none present.`,
    );
  }
}

/* ------------------------------------------------------------------ */

if (!existsSync(distDir)) {
  console.error(
    `check-build-output: no build at ${distDir}. Run \`next build\` first (this script ` +
      `runs after the build step in integration.yml).`,
  );
  process.exit(1);
}

checkMiddlewareCompiled();
checkNoSecretsInClientBundle();

if (failures.length > 0) {
  console.error("\nBuild-output assertions failed:\n");
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  process.exit(1);
}

console.log("\nBuild-output assertions passed.");
