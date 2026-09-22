#!/usr/bin/env node
// Compose the Cloud Run target's runtime secret file ([D-184]).
//
// Reads the same two JSON sources infra/infisical/push-vercel-env.sh feeds to
// vercel-env.mjs — Infisical `production` at `/`, and the production R2
// buckets from infra/cloudflare-r2's Tofu state — and writes ONE env-file to
// stdout, which infra/gcp/push-cloudrun-env.sh pipes into
// `gcloud secrets versions add --data-file=-`.
//
//   … | node scripts/cloudrun-env.mjs compose | gcloud secrets versions add …
//
// ⚠️ WHY IT IMPORTS FROM vercel-env.mjs rather than restating the shape. The
// question "what is the runtime secret set" has exactly one answer, and the two
// off-Fly targets must not be able to disagree about it — a key that reached
// Vercel and not Cloud Run would be a difference nothing would report until a
// cutover. `pushedEntries` already refuses an empty Infisical read, refuses a
// name that is not an environment variable name, and refuses a key arriving
// from both sources. All three refusals are wanted here unchanged, and the way
// to keep them identical is to call them, not to copy them. The module is named
// for the target that first needed it; the function is not Vercel-specific.
//
// ⚠️ VALUES NEVER REACH ARGV. They arrive on stdin and leave on stdout, into a
// pipe. Nothing here writes a temporary file, and the caller passes no value as
// an argument — see D-66, and infra/gcp/README.md's third reason.
//
// ⚠️ THE GRAMMAR IS scripts/docker-entrypoint.sh's, not a shell's. The
// entrypoint reads `KEY=value` a line at a time and does NOT evaluate the
// value: no quoting, no escaping, no `$` expansion. So a value containing a
// newline cannot survive the round trip, and this refuses one rather than
// writing a file that silently truncates a key — the failure would otherwise
// appear as a Zod parse error at boot, pointing at the wrong thing.

import { pushedEntries } from "./vercel-env.mjs";

/**
 * The env-file text for a set of entries.
 *
 * @param {Map<string, { value: string; owner: string }>} desired
 * @returns {string}
 */
export function composeEnvFile(desired) {
  const lines = [
    "# Written by infra/gcp/push-cloudrun-env.sh — do not edit by hand.",
    "# Sourced by scripts/docker-entrypoint.sh from the path in SECRETS_ENV_FILE.",
    "# One Secret Manager version holds this whole file (D-184).",
  ];
  for (const [key, { value }] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
    if (/[\n\r]/.test(value)) {
      throw new Error(
        `${key} contains a newline, which the entrypoint's line-at-a-time grammar ` +
          `cannot represent. Fix the value at its source rather than escaping it here.`,
      );
    }
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The names written, for a report that says what happened without saying any value. */
export const namesOf = (desired) => [...desired.keys()].sort();

async function main(argv) {
  if (argv[0] !== "compose") {
    console.error("usage: … | node scripts/cloudrun-env.mjs compose");
    process.exit(1);
  }

  let sources;
  try {
    const { readFileSync } = await import("node:fs");
    sources = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    console.error("cloudrun-env: stdin is not valid JSON");
    process.exit(1);
  }

  const desired = pushedEntries(sources);
  process.stdout.write(composeEnvFile(desired));
  // stderr, so it cannot contaminate the secret on stdout.
  console.error(`  ${desired.size} names: ${namesOf(desired).join(", ")}`);
}

// Only when run, so the tests can import the pure halves.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
