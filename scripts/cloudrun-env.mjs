#!/usr/bin/env node
// Compose the Cloud Run target's runtime secret file ([D-184]).
//
// Reads two JSON sources — Infisical `production` at `/`, and the production R2
// buckets from infra/cloudflare-r2's Tofu state — and writes ONE env-file to
// stdout, which infra/gcp/push-cloudrun-env.sh pipes into
// `gcloud secrets versions add --data-file=-`.
//
//   … | node scripts/cloudrun-env.mjs compose | gcloud secrets versions add …
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

/** The only environment whose buckets reach the production secret (D-65). */
const ENVIRONMENT = "production";

/** Which source a name came from, so a clash can say where each half arrived. */
export const SOURCE = {
  infisical: "Infisical production /",
  r2: "infra/cloudflare-r2",
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `tofu output -json buckets` → five names per PRODUCTION bucket, spelled the
 * way the app reads them (`<env_prefix>_BUCKET`, `_ENDPOINT`, `_REGION`,
 * `_ACCESS_KEY`, `_SECRET`). A null field is a bucket still mid-adoption (see
 * that module's outputs.tf), and writing it would set a credential to the
 * string "null".
 */
export function r2Entries(buckets) {
  const entries = [];
  for (const [name, bucket] of Object.entries(buckets ?? {})) {
    if (bucket?.environment !== ENVIRONMENT) continue;
    const fields = {
      BUCKET: bucket.bucket,
      ENDPOINT: bucket.endpoint,
      REGION: bucket.region,
      ACCESS_KEY: bucket.access_key_id,
      SECRET: bucket.secret_access_key,
    };
    for (const [suffix, value] of Object.entries(fields)) {
      if (typeof value !== "string" || value === "") {
        throw new Error(`tofu output: bucket ${name} has no ${suffix.toLowerCase()} yet`);
      }
      entries.push({ key: `${bucket.env_prefix}_${suffix}`, value });
    }
  }
  if (entries.length === 0) {
    throw new Error("tofu output: no production buckets — is this infra/cloudflare-r2's state?");
  }
  return entries;
}

/**
 * The whole runtime secret set, keyed by name. An empty Infisical read is
 * refused — it would replace every secret with nothing — and so is one name
 * arriving from both sources, because which value won would depend on the
 * order of two loops rather than on anyone's intent.
 */
export function pushedEntries({ infisical, r2 }) {
  if (!Array.isArray(infisical) || infisical.length === 0) {
    throw new Error("Infisical production / returned no secrets — refusing an empty push");
  }
  const desired = new Map();
  const add = (key, value, owner) => {
    if (typeof key !== "string" || !NAME.test(key)) {
      throw new Error(`${owner}: not an environment variable name: ${String(key)}`);
    }
    if (typeof value !== "string") throw new Error(`${owner}: ${key} has no string value`);
    if (desired.has(key)) {
      throw new Error(`${key} comes from both ${desired.get(key).owner} and ${owner}`);
    }
    desired.set(key, { value, owner });
  };
  for (const { key, value } of infisical) add(key, value, SOURCE.infisical);
  for (const { key, value } of r2Entries(r2)) add(key, value, SOURCE.r2);
  return desired;
}

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
