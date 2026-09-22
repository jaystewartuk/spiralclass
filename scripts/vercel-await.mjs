#!/usr/bin/env node
// Waits for ONE Vercel deployment to finish, and fails — saying why — on any
// state that is not on its way to finishing.
//
// scripts/vercel-deploy.sh deploys with `--no-wait` and hands the URL here,
// because the CLI's own wait has no deadline and knows only three ways out:
// READY, ERROR and CANCELED. On 2026-09-18 and 2026-09-19 Vercel put the
// failover's deployment in BLOCKED — Vercel's commit-author check, which a CLI
// deploy is subject to because the CLI sends the commit's author with it —
// and the CLI printed "Building…" until the job's 30-minute timeout cancelled
// it. Nothing in the log said what Vercel had decided, or that it had decided
// anything within the first second.
//
// So the rule here is the inverse of the CLI's: a deployment is waited on ONLY
// while its state is one this file knows means "still going". READY passes.
// Everything else — ERROR, CANCELED, BLOCKED, and any state Vercel adds after
// this was written — is a failure reported with Vercel's own reason, because a
// state nobody recognises is one nobody should be waiting on.
//
// Reads VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID as the CLI does, and
// prints no value of any of them.
//
// Usage:
//   node scripts/vercel-await.mjs <deployment-url-or-id> [--timeout-seconds N]

import { pathToFileURL } from "node:url";

import { credentials, vercelClient } from "./vercel-env.mjs";

/** The states that mean Vercel is still working on it. Nothing else is waited on. */
export const IN_PROGRESS = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);

/** Long enough for a build queued behind another; a prebuilt deploy takes under a minute. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const INTERVAL_MS = 5_000;

/** Consecutive transient API failures tolerated before giving up. */
const MAX_TRANSIENT = 5;

/**
 * `https://x.vercel.app`, `x.vercel.app` or `dpl_…` → what the deployments API
 * takes. The CLI's stdout is the URL, but it is captured from a subshell, so
 * this takes the last `https://` host in it rather than trusting the whole
 * string — and never a bare dotted word, which "Vercel CLI 59.15.1" would be.
 */
export function deploymentRef(arg) {
  const text = String(arg ?? "").trim();
  const urls = [...text.matchAll(/https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) => m[1]);
  if (urls.length > 0) return urls[urls.length - 1];
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(text)) return text;
  if (/^dpl_[A-Za-z0-9]+$/.test(text)) return text;
  return null;
}

/**
 * One deployment → what to do about it. Pure.
 *   { done: false }                    keep waiting
 *   { done: true, ok: true }           READY
 *   { done: true, ok: false, lines }   anything else, with Vercel's reason
 */
export function verdict(deployment) {
  const state = deployment?.readyState;
  if (state === "READY") return { done: true, ok: true, lines: [] };
  if (IN_PROGRESS.has(state)) return { done: false, lines: [] };

  const d = deployment ?? {};
  const lines = [
    `Vercel's state for this deployment is ${state ?? "(none)"}` +
      (d.readySubstate ? ` / ${d.readySubstate}` : "") +
      ", which is not one it finishes from.",
  ];
  if (d.errorCode || d.errorMessage) {
    lines.push(`  ${[d.errorCode, d.errorMessage].filter(Boolean).join(": ")}`);
  }
  if (state === "BLOCKED") {
    // The only BLOCKED cause seen so far, and the one Vercel's errorLink points
    // at. Said as what Vercel checks rather than as a certainty, because the
    // API response does not name the cause.
    const author = d.meta?.githubCommitAuthorEmail;
    lines.push(
      "  Vercel blocks a deployment before building it when it cannot match the",
      `  commit's author${author ? ` (${author})` : ""} to an account allowed to deploy it —`,
      "  a CLI deploy sends the commit's author with it. The fix is on Vercel, not in",
      "  this repository: connect GitHub under Account Settings → Authentication →",
      "  Login Connections on the account that owns the project, then re-run the job.",
    );
  }
  if (d.errorLink) lines.push(`  Vercel's explanation: ${d.errorLink}`);
  return { done: true, ok: false, lines };
}

/**
 * Polls until `verdict` says done, the deadline passes, or the API refuses.
 * Resolves to an exit code. Every dependency is a parameter so the tests run
 * the whole loop on a fake clock.
 */
export async function awaitDeployment({
  ref,
  get,
  log,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = INTERVAL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + timeoutMs;
  let last = null;
  let transient = 0;

  for (;;) {
    let deployment;
    try {
      deployment = await get(ref);
      transient = 0;
    } catch (error) {
      const status = typeof error?.status === "number" ? error.status : null;
      // A 4xx will not change by asking again: a wrong id, a token without
      // access to the project. Waiting out the deadline would only hide it.
      if (status !== null && status >= 400 && status < 500 && status !== 429) {
        log(`vercel-await: ${error.message}`);
        return 1;
      }
      transient += 1;
      if (transient >= MAX_TRANSIENT) {
        log(`vercel-await: ${error?.message ?? error} — ${transient} times in a row, giving up.`);
        return 1;
      }
    }

    if (deployment) {
      const state = deployment.readyState ?? "(none)";
      if (state !== last) {
        log(`› ${ref}: ${state}`);
        last = state;
      }
      const v = verdict(deployment);
      if (v.done) {
        for (const line of v.lines) log(line);
        return v.ok ? 0 : 1;
      }
    }

    if (now() >= deadline) {
      log(
        `vercel-await: still ${last ?? "unreadable"} after ${Math.round(timeoutMs / 1000)}s. ` +
          "Refusing to wait longer — open the deployment in the Vercel dashboard for why.",
      );
      return 1;
    }
    await sleep(intervalMs);
  }
}

async function main(argv, env) {
  const log = (line) => process.stderr.write(`${line}\n`);
  const usage = "usage: vercel-await.mjs <deployment-url-or-id> [--timeout-seconds N]";

  const [target, ...rest] = argv;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rest.length === 2 && rest[0] === "--timeout-seconds" && /^\d+$/.test(rest[1])) {
    timeoutMs = Number(rest[1]) * 1000;
  } else if (rest.length > 0) {
    log(usage);
    return 1;
  }

  const ref = deploymentRef(target);
  if (!ref) {
    log(`vercel-await: no deployment URL or id in ${JSON.stringify(target ?? "")}\n${usage}`);
    return 1;
  }
  const client = vercelClient(credentials(env));
  return awaitDeployment({ ref, get: (r) => client.deployment(r), log, timeoutMs });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`vercel-await: ${error.message}\n`);
      process.exit(1);
    },
  );
}
