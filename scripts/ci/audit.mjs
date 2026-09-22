#!/usr/bin/env node
//
// The dependency audit, with one distinction the bare `pnpm audit` cannot make:
// **a vulnerability is a verdict; an unreachable advisory database is not.**
//
// `pnpm audit` asks registry.npmjs.org's `security/advisories/bulk` endpoint
// what it knows. When that endpoint is down — and on 2026-09-03 it was down, on
// and off, for well over an hour while the registry itself served fine — pnpm
// exits non-zero with a TimeoutError. The gate read that as "this tree has a
// high-severity vulnerability" and went red, on every branch, on every push, in
// both tiers. Nothing could be pushed, merged, promoted or deployed by anyone,
// because a third party's endpoint was slow. That is a bad trade: the audit
// exists to stop a known-vulnerable dependency reaching production, and it was
// instead stopping everything from reaching production while telling us nothing
// about vulnerabilities either way.
//
// So: findings still fail, exactly as before. A transport failure warns loudly
// and passes, and says so, because a check that could not run must not
// masquerade as a check that passed — nor as one that failed.
//
// The retry window is cut too. pnpm's default is three attempts backing off to
// roughly four minutes; against a dead endpoint that is four minutes to learn
// nothing, paid once per gate run and once per PR in a batch. One retry is
// enough to ride out a blip.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ARGS = ["audit", "--prod", "--audit-level", "high"];

// Transport, not verdict. These are the shapes an unreachable or refusing
// registry produces; none is anything an advisory finding prints.
const TRANSPORT_FAILURE = [
  /The operation was aborted due to timeout/i,
  /TimeoutError/,
  /ERR_SOCKET_TIMEOUT/,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/,
  /request to \S+ failed/i,
  /https:\/\/registry\.npmjs\.org\S*\s+error/i,
  /registry\.npmjs\.org[^\n]*\b(429|500|502|503|504)\b/i,
];

// A real audit always prints a count. If we can see one the audit RAN, and its
// answer stands whatever else is in the output — a timeout line from a retry
// that later succeeded must never be read as "we learned nothing".
const HAS_VERDICT = /\b\d+\s+vulnerabilit(y|ies)\b/i;

/** The advisory database answered, whatever else went wrong getting there. */
export function reachedTheDatabase(output) {
  return HAS_VERDICT.test(output);
}

/** The failure is about the network, not about this tree's dependencies. */
export function isTransportFailure(output) {
  return TRANSPORT_FAILURE.some((re) => re.test(output));
}

/**
 * What to do with a non-zero `pnpm audit` — "fail" or "skip".
 *
 * Split out from the process plumbing so the fail-open path, which is the one
 * that could hide a real vulnerability, is tested against real pnpm output
 * rather than trusted. Note the order: an answer from the database always
 * wins, so output containing BOTH a retry timeout and a final count fails.
 */
export function verdictFor(output) {
  if (reachedTheDatabase(output)) return "fail";
  return isTransportFailure(output) ? "skip" : "fail";
}

function main() {
  const res = spawnSync("pnpm", ARGS, {
    encoding: "utf8",
    env: {
      ...process.env,
      // One retry, short ceiling: enough for a blip, not four minutes of
      // nothing.
      npm_config_fetch_retries: "1",
      npm_config_fetch_retry_maxtimeout: "10000",
      npm_config_fetch_timeout: "20000",
    },
  });

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  process.stdout.write(out);

  if (res.status === 0) return 0;

  if (verdictFor(out) === "skip") {
    console.warn(
      [
        "",
        "  ⚠ AUDIT SKIPPED — the advisory database could not be reached.",
        "",
        "    This is NOT a pass. pnpm never got an answer out of",
        "    registry.npmjs.org, so nothing is known about this tree's",
        "    dependencies right now, good or bad.",
        "",
        "    The gate goes green anyway, deliberately: an outage at npm must",
        "    not be able to stop every push, merge and deploy. Re-run the step",
        "    once the endpoint is back:  pnpm gate --only audit",
        "",
      ].join("\n"),
    );
    return 0;
  }

  console.error(
    [
      "",
      "  ✗ audit failed with findings, or with an error that is not a transport",
      "    failure. This is a verdict about the tree, not about the network.",
      "",
    ].join("\n"),
  );
  return res.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
