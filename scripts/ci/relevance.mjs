/**
 * Whether a set of changed files can actually affect what preview serves.
 *
 * `pnpm ship:preview` deploys the web app, and since [D-157] so does
 * .github/workflows/deploy-preview.yml on every push to `main`. Many commits
 * change nothing the deploy carries — docs, CI scripts, tests — and deploying
 * regardless is not free: a migration runs, an image is built and pushed, and
 * every machine in the app is replaced.
 *
 * The workflow calls the CLI at the foot of this file rather than declaring
 * `on.push.paths` globs, because a glob list in YAML is a SECOND answer to
 * this question — one that drifts from this one silently and is not covered by
 * the table tests below. There is one predicate and it lives here.
 *
 * So this decides. The bias is deliberate and one-directional: anything this
 * function does not recognise counts as affecting the deploy. A redundant
 * deploy costs time; a skipped one ships nothing and looks like it shipped.
 * Only paths that provably cannot reach a built artifact are ignored outright.
 *
 * The shape is kept (an object, not a boolean) because the cost of the extra
 * key is one property and the cost of collapsing it is every caller.
 *
 * Pure and table-tested (apps/web/tests/config/relevance.test.ts) — the whole
 * value here is in the edge cases, and none of them need a repo to reason about.
 */

/**
 * Paths that cannot change what runs on a server. Each entry is a claim you can
 * check: no bundler or Docker build reads it.
 */
const IGNORED = [
  /^docs\//,
  /^\.github\//,
  /^\.githooks\//,
  /^\.claude\//,
  /^infra\//, // Tofu/DB/ops tooling — separate lifecycle, never bundled
  /^scripts\/ci\//, // the gate + ship scripts themselves
  /^justfile$/,
  /\.md$/,
  // Tests and their fixtures. Vitest and Playwright files are not part of the
  // Next standalone output.
  /(^|\/)tests?\//,
  /(^|\/)e2e\//,
  /(^|\/)__tests__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
];

const isIgnored = (file) => IGNORED.some((re) => re.test(file));

/**
 * @param {string[]} files  repo-relative paths (git diff --name-only)
 * @returns {{web: boolean}} whether the deploy needs to run
 */
export function changedTargets(files) {
  const targets = { web: false };
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || isIgnored(file)) continue;

    if (file.startsWith("apps/web/")) {
      targets.web = true;
      continue;
    }
    // packages/shared is imported by the web app; packages/* generally is
    // either shared code or a standalone tool, and "standalone tool" is not
    // worth special-casing in the direction of shipping less.
    if (file.startsWith("packages/")) {
      targets.web = true;
      continue;
    }
    // Everything else lives at the root: the lockfile, Dockerfile, fly.*.toml,
    // turbo.json, tsconfig. Any of them can change the artifact, and an
    // unrecognised new root file is exactly the case where guessing "nothing"
    // would be worst.
    targets.web = true;
  }
  return targets;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Answers the same question for a git range, for callers that are not Node —
// principally .github/workflows/deploy-preview.yml.
//
//   node scripts/ci/relevance.mjs <base-ref> <head-ref>
//
// Prints `web=true` or `web=false`, and appends the same line to $GITHUB_OUTPUT
// when it is set, so a workflow reads it as a step output.
//
// FAILS OPEN, in the same direction as changedTargets itself: if the range
// cannot be diffed (a first push, a force-push that orphaned the base, a
// shallow clone) the answer is `web=true`. Deploying something inert wastes a
// few minutes; skipping a deploy that mattered ships nothing and looks like it
// shipped, and that asymmetry is why this file exists at all.
async function main(argv) {
  const [base, head = "HEAD"] = argv;
  const { execFileSync } = await import("node:child_process");
  const { appendFileSync } = await import("node:fs");

  let web = true;
  let why = "could not diff the range — assuming the deploy is affected";
  if (base) {
    try {
      const out = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
        encoding: "utf8",
      });
      const files = out.split("\n").filter(Boolean);
      web = changedTargets(files).web;
      why = `${files.length} changed file(s) between ${base} and ${head}`;
      console.log(files.length ? files.map((f) => `  ${f}`).join("\n") : "  (no files)");
    } catch (error) {
      console.error(`relevance: ${error.message.trim()}`);
    }
  }

  const line = `web=${web}`;
  console.log(`\n${line} — ${why}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(await main(process.argv.slice(2)));
}
