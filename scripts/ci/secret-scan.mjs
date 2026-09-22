#!/usr/bin/env node
//
// The credential half of the leak gate: gitleaks, scoped to what git would
// actually publish.
//
// WHY THIS EXISTS ALONGSIDE scripts/check-leaks.mjs. The two are good at
// different halves and neither subsumes the other — see .gitleaks.toml's header
// for the full argument. Short version: check-leaks.mjs owns the classes a
// general scanner has no concept of (this operator's account identifiers, a
// real person's address in a fixture); gitleaks owns credentials, with ~170
// curated provider rules and entropy analysis maintained by people who watch
// credential formats change. A hand-written regex list is weakest exactly where
// high-entropy strings are concerned.
//
// WHY A WRAPPER, WHEN gitleaks IS A PERFECTLY GOOD BINARY.
// **gitleaks does not respect .gitignore, and a gate must assert about what
// will be COMMITTED, not about what happens to be on this developer's disk.**
// Run bare over this repo it reports 15 findings on a clean tree — every one a
// real credential in `apps/web/.env.local`, `apps/web/.auth/` or
// `config/env/*.local.env`, all of which are gitignored and cannot reach a
// commit. That gate is red on every push forever, so within a week it is either
// deleted or `--skip`ped, and either way it is not protecting anything.
//
// Adding those paths to .gitleaks.toml's allowlist would be the obvious fix and
// the wrong one: the allowlist would be a second copy of .gitignore, drifting
// from it silently, and a NEW gitignored secret file would be reported until
// someone remembered to add it. So the partition is computed from git itself,
// with one batched `git check-ignore --stdin` — the same mechanism, for the
// same reason, as check-leaks.mjs's gitignoredPaths().
//
// WHAT IS AND IS NOT A FAILURE
//   * A finding in a file git would publish — RED. That is the whole point.
//   * A finding only in gitignored files — green, with a one-line note. It is
//     real credential material and it is correctly outside the publish
//     boundary; reporting the count is useful evidence that .gitignore is
//     holding, which is worth printing and not worth failing.
//   * gitleaks missing, or exiting on something that is not a finding — RED.
//     Unlike scripts/ci/audit.mjs there is no third party to be down: gitleaks
//     is local and offline, so "could not run" has no benign explanation and
//     must not pass. gate.mjs refuses earlier still, via `needs: ["gitleaks"]`.
//
//   node scripts/ci/secret-scan.mjs           scan (exit 1 on a publishable finding)
//   node scripts/ci/secret-scan.mjs --all     also fail on gitignored findings

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/**
 * Split findings into the ones that would be published and the ones git is
 * already excluding.
 *
 * Pure, and exported, so the partition is testable without a gitleaks binary
 * or a repo full of planted secrets.
 *
 * @param {Array<{File: string}>} findings
 * @param {(paths: string[]) => Set<string>} ignoredPaths
 */
export function partitionFindings(findings, ignoredPaths) {
  const ignored = ignoredPaths(findings.map((f) => f.File));
  const publishable = [];
  const excluded = [];
  for (const f of findings) (ignored.has(f.File) ? excluded : publishable).push(f);
  return { publishable, excluded };
}

/**
 * One batched `git check-ignore`, because per-file would be a process per
 * finding. Exit 1 means "nothing ignored", which is an answer and not a
 * failure; anything else (git missing, not a repo) returns an empty set so the
 * scan reports EVERYTHING rather than silently calling findings ignored. Fail
 * loud, not open — the opposite default from check-leaks.mjs's walk, because
 * here an empty set is the conservative answer.
 */
function gitignoredPaths(paths) {
  if (paths.length === 0) return new Set();
  const res = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: REPO_ROOT,
    input: paths.join("\n"),
    encoding: "utf8",
  });
  if (res.status !== 0 && res.status !== 1) return new Set();
  return new Set((res.stdout || "").split("\n").filter(Boolean));
}

function die(lines) {
  console.error(["", ...lines.map((l) => `  ${l}`), ""].join("\n"));
  process.exit(1);
}

function main() {
  const failOnIgnored = process.argv.includes("--all");

  if (spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status !== 0) {
    die([
      "gitleaks is not installed, and the secret scan cannot run.",
      "",
      "  brew install gitleaks        (macOS)",
      "  https://github.com/gitleaks/gitleaks#installing",
      "",
      "⚠ Do NOT `pnpm add gitleaks` — the npm package of that name is unrelated",
      "  to this tool (a third party's v1.0.0, against the real project's 8.x).",
    ]);
  }

  const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
  const report = join(dir, "report.json");
  try {
    const res = spawnSync(
      "gitleaks",
      [
        "dir",
        ".",
        "--config",
        ".gitleaks.toml",
        "--report-format",
        "json",
        "--report-path",
        report,
        "--redact",
        "--no-banner",
        // Findings are this script's verdict to make, after the gitignore
        // partition. gitleaks' own exit code would pre-empt it.
        "--exit-code",
        "0",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    if (res.status !== 0) {
      die([
        `gitleaks exited ${res.status} without completing a scan.`,
        "This is not a finding — it is the scanner failing to run, which cannot pass.",
        "",
        (res.stderr || res.stdout || "").trim().split("\n").slice(-8).join("\n  "),
      ]);
    }

    /** @type {Array<{File: string, StartLine: number, RuleID: string}>} */
    let findings;
    try {
      findings = JSON.parse(readFileSync(report, "utf8")) ?? [];
    } catch (err) {
      die([`gitleaks wrote no readable report to ${report}: ${err.message}`]);
      return;
    }

    const { publishable, excluded } = partitionFindings(findings, gitignoredPaths);

    if (publishable.length > 0) {
      console.error(`\n${publishable.length} possible credential(s) in files git would publish:\n`);
      for (const f of publishable) {
        console.error(`  ${f.RuleID}\n    ${f.File}:${f.StartLine}`);
      }
      console.error(
        [
          "",
          "Rotate the credential FIRST — a key that reached a commit is compromised",
          "from that moment and removing it from the source does not un-compromise it.",
          "",
          "If it is genuinely not a credential, add a justified allowlist entry to",
          ".gitleaks.toml. Keep the reason: an unexplained entry in a credential",
          "scanner is indistinguishable from a leak somebody silenced.",
          "",
        ].join("\n  "),
      );
      process.exit(1);
    }

    if (excluded.length > 0 && failOnIgnored) {
      console.error(`\n${excluded.length} finding(s) in gitignored files, and --all was passed.\n`);
      for (const f of excluded) console.error(`  ${f.RuleID}\n    ${f.File}:${f.StartLine}`);
      process.exit(1);
    }

    const note = excluded.length
      ? ` ${excluded.length} finding(s) sit in gitignored files (real credentials, correctly` +
        ` outside the publish boundary).`
      : "";
    console.log(`secret-scan: no credentials in any file git would publish.${note}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) main();
