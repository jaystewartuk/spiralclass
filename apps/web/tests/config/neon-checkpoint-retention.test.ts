import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// REPO_ROOT is the repo-root resolver the config tooling already exports (D-85).
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// Locks the checkpoint-retention contract for the pre-migration Neon safety net
// (D-95): `scripts/database-deploy.sh`'s production path creates a `pre-deploy-*`
// branch before any migration touches production, and that step fails closed.
// Since the production targets were split ([D-177]'s addendum) that script is
// the deploy workflow's `database` job, and the first thing a hand-run
// `scripts/fly-deploy.sh` does — it was steps 1 and 2 of the Fly script until
// then, which is why the older notes below name that file.
//
// Why this test matters: the retention count is bounded from BOTH sides, and
// both bounds fail silently.
//   - Too high, and checkpoints accumulate until the Neon project hits its
//     per-project branch ceiling. `branches create` then fails with "branches
//     limit exceeded" and — because the checkpoint is the first step of the
//     production deploy job — aborts the production deploy. Nothing goes red
//     until the day the ceiling is reached; the default shipped at 20 against a
//     ceiling of 10 for weeks, with the failure permanently ~7 deploys away.
//   - Too low (1), and the only rollback depth is Neon's PITR window, which is
//     measured in hours. "A bad migration shipped Monday, noticed Wednesday"
//     has no restore point at all.
// The number used to live in two files read at different times — the composite
// action's input default (what CI passed) and the script's own KEEP (what a
// human running it by hand got) — and they could disagree without anything
// noticing. D-129 deleted every workflow and composite action in this repo, so
// the script is now the only definition. What still has to hold is that the
// only call site doesn't quietly override it.

const SCRIPT_SH = resolve(REPO_ROOT, "infra/database/scripts/neon-checkpoint.sh");
const DATABASE_DEPLOY_SH = resolve(REPO_ROOT, "scripts/database-deploy.sh");
const FLY_DEPLOY_SH = resolve(REPO_ROOT, "scripts/fly-deploy.sh");

// The production Neon project's per-project branch ceiling (`owner.branches_limit`
// on `GET /projects/<id>`), measured 2026-08-09 on the Free plan. This constant
// is a REGRESSION FLOOR for the test, not the mechanism: neon-checkpoint.sh
// reads the real limit from the API at runtime and refuses to proceed if
// retention no longer fits, so a plan change relaxes reality without this
// number needing to be right. It only has to stay conservative.
const OBSERVED_BRANCH_CEILING = 10;

/** The `KEEP` default — now the single definition, in the script every path runs. */
function keepDefaultFromScript(): number {
  const sh = readFileSync(SCRIPT_SH, "utf8");
  const raw = sh.match(/^KEEP=(\d+)$/m);
  if (!raw) {
    throw new Error(
      "Could not find the `KEEP=<n>` default in infra/database/scripts/neon-checkpoint.sh — was it renamed or made non-literal?",
    );
  }
  return Number(raw[1]);
}

describe("neon checkpoint retention", () => {
  it("leaves headroom under the Neon project's branch ceiling", () => {
    const keep = keepDefaultFromScript();
    // +1 for the parent branch (`production`) itself, which is never a
    // checkpoint and always occupies a slot. Retention has to fit alongside it
    // with room left over for ad-hoc branches: a rehearsal branch, or the
    // `<target>_pre_rollback_<ts>` branch `neon-rollback.sh` creates as its
    // safety net during an actual restore — an incident is the worst possible
    // moment to discover the project is one branch from its ceiling.
    expect(keep + 1).toBeLessThan(OBSERVED_BRANCH_CEILING);
  });

  it("keeps more than one checkpoint, so rollback depth outlives the PITR window", () => {
    // Neon PITR covers hours on this plan; checkpoints are what cover "noticed
    // it days later". A single checkpoint only ever reaches back to the
    // previous deploy.
    expect(keepDefaultFromScript()).toBeGreaterThan(1);
  });

  it("creates checkpoint branches without a compute endpoint", () => {
    const sh = readFileSync(SCRIPT_SH, "utf8");
    const create = sh.match(/^(?!\s*#).*branches create .*$/m)?.[0];
    expect(create, "no `branches create` invocation found in neon-checkpoint.sh").toBeTruthy();
    // A restore point needs no live endpoint — neon-rollback.sh never connects
    // to the checkpoint. Dropping this would silently start spinning an
    // endpoint per deploy again.
    expect(create).toContain("--no-compute");
  });

  it("checks the branch ceiling before creating anything", () => {
    const sh = readFileSync(SCRIPT_SH, "utf8");
    // The precondition is the whole point of this change: without it, an
    // over-ceiling retention target surfaces as "branches limit exceeded"
    // partway through a production deploy instead of naming its own cause.
    expect(sh).toMatch(/^check_branch_ceiling$/m);
    expect(sh).toContain("branches_limit");
  });

  it("is not overridden at the only call site, so the script default is what production runs", () => {
    const sh = readFileSync(DATABASE_DEPLOY_SH, "utf8");
    const call = sh.match(/^(?!\s*#).*neon-checkpoint\.sh.*$/m)?.[0];
    expect(
      call,
      "no neon-checkpoint.sh invocation found in scripts/database-deploy.sh",
    ).toBeTruthy();
    // If the call site ever DOES pass --keep, that value — not the script's
    // default — is what production runs with, and the bounds asserted above stop
    // describing reality. Pin them together in that same change.
    expect(call).not.toContain("--keep");
  });

  // Added 2026-09-06, with the publication audit that took this repo public.
  //
  // The script used to default NEON_PROJECT_ID to the production project id,
  // written out in full in the line that exported it. That read as free — an id
  // is not a credential and it kept the laptop path zero-config — and it is not
  // free in a public repository: it names the exact Neon project holding real
  // student data, which is the reconnaissance surface D-158 exists to remove.
  // The audit found it in four places, and `check-leaks.mjs` passed all four
  // because the identifier gate had no pattern for the database.
  //
  // Two assertions, because removing the default and removing the literal are
  // different failures. A future edit could reintroduce either alone.
  it("names no Neon project id, so the production database is not identified in the tree", () => {
    // Both scripts: the one that carried the id, and the one its code moved to.
    for (const [name, path] of [
      ["scripts/fly-deploy.sh", FLY_DEPLOY_SH],
      ["scripts/database-deploy.sh", DATABASE_DEPLOY_SH],
    ] as const) {
      const sh = readFileSync(path, "utf8");
      // Neon's shape: <adjective>-<noun>-<8 digits>. Same shape check-leaks.mjs
      // now gates the whole tree on; asserted here too so the call site that
      // used to carry one says why it must not again.
      const found = sh.match(/\b(?:org-)?[a-z]+-[a-z]+-\d{8}\b/);
      expect(
        found?.[0],
        `${name} names a Neon project id (${found?.[0]}). ` +
          "Supply it as the NEON_PROJECT_ID environment secret instead — see D-158.",
      ).toBeUndefined();
    }
  });

  it("a hand-run Fly deploy still checkpoints first, unless the workflow's database job already did", () => {
    // The split must not have taken the checkpoint off the recovery path. A
    // bare `fly-deploy.sh production` runs database-deploy.sh before it builds
    // anything; only --database-already-deployed skips it, and that flag's one
    // honest caller is pinned in production-targets.test.ts.
    const sh = readFileSync(FLY_DEPLOY_SH, "utf8");
    const call = sh.match(/^(?!\s*#).*bash scripts\/database-deploy\.sh .*$/m)?.[0];
    expect(call, "scripts/fly-deploy.sh no longer runs scripts/database-deploy.sh").toBeTruthy();
    expect(sh.indexOf(call!), "the database step must run before the image is built").toBeLessThan(
      sh.indexOf("docker buildx build"),
    );
    expect(sh.slice(0, sh.indexOf(call!))).toMatch(
      /if \[ "\$DATABASE_ALREADY_DEPLOYED" = 1 \]; then/,
    );
  });

  it("refuses the production deploy when NEON_PROJECT_ID is unset, rather than guessing", () => {
    const sh = readFileSync(DATABASE_DEPLOY_SH, "utf8");
    // Fail-closed, and it must fail BEFORE the checkpoint and the migrations —
    // the whole reason a missing value here is cheap. Same posture as
    // LIVEKIT_ORIGIN_IP in scripts/local/synthetic.sh: refuse rather than guess.
    const guard = sh.indexOf('if [ -z "${NEON_PROJECT_ID:-}" ]; then');
    expect(guard, "no fail-closed guard for NEON_PROJECT_ID in database-deploy.sh").toBeGreaterThan(
      -1,
    );

    // The INVOCATION, not the first mention — the script's header comment names
    // neon-checkpoint.sh long before it runs it, and indexOf finds that instead.
    // Same non-comment matcher the retention assertion above uses.
    const invocation = sh.match(/^(?!\s*#).*neon-checkpoint\.sh.*$/m);
    expect(invocation, "no neon-checkpoint.sh invocation found in database-deploy.sh").toBeTruthy();
    const checkpoint = sh.indexOf(invocation![0]);
    expect(
      guard,
      "the NEON_PROJECT_ID guard must come before the checkpoint runs, or a " +
        "missing value costs a half-finished deploy instead of a re-run.",
    ).toBeLessThan(checkpoint);

    // A `${NEON_PROJECT_ID:-<anything>}` default would make the guard dead code.
    expect(sh).not.toMatch(/NEON_PROJECT_ID:-[^}]/);
  });
});

// How neonctl authenticates, changed 2026-08-31 (the D-146 follow-up).
//
// `fly-deploy.sh` used to fetch a long-lived NEON_API_KEY from Infisical's
// `infra` environment on every production deploy. The keys were deleted, the
// checkpoint fail-closed exactly as designed, and the deploy stopped with
// `production` already fast-forwarded and the app still on the previous
// release — the branch moved and the running app did not. neonctl was always
// the tool; only the credential changed, to the OAuth one `neonctl auth`
// stores per machine, which is sufficient because this laptop is the only
// thing that deploys (D-129).
//
// Two things must hold, and they pull in opposite directions:
//   1. The key is no longer REQUIRED, or the deploy is coupled to a secret
//      again.
//   2. The refusal is unchanged. Losing the key was never the danger; a
//      migration with no restore point is. "No checkpoint, no deploy" (D-95)
//      has to survive a change whose whole subject is the credential.
describe("neon auth (D-146 follow-up)", () => {
  const checkpoint = () => readFileSync(SCRIPT_SH, "utf8");
  const common = () =>
    readFileSync(resolve(REPO_ROOT, "infra/database/scripts/_common.sh"), "utf8");
  const rollback = () =>
    readFileSync(resolve(REPO_ROOT, "infra/database/scripts/neon-rollback.sh"), "utf8");

  it("neither script hard-requires NEON_API_KEY any more", () => {
    // The exact guard that broke the deploy: `[ -n "${NEON_API_KEY:-}" ] || die`.
    for (const [name, src] of [
      ["neon-checkpoint.sh", checkpoint()],
      ["neon-rollback.sh", rollback()],
    ] as const) {
      expect(src, `${name} still dies when NEON_API_KEY is unset`).not.toMatch(
        /\[ -n "\$\{NEON_API_KEY:-\}" \] \|\| die/,
      );
    }
  });

  it("both scripts authenticate through the one shared helper", () => {
    // Separately-implemented auth is how a rollback tool ends up failing
    // during the incident it exists for, having looked fine every other day.
    expect(common()).toMatch(/ensure_neon_auth\(\)/);
    expect(checkpoint()).toMatch(/ensure_neon_auth "\$\{NEON_CLI\[@\]\}"/);
    expect(rollback()).toMatch(/ensure_neon_auth "\$\{NEON_CLI\[@\]\}"/);
  });

  it("an explicitly exported NEON_API_KEY still wins, and never reaches argv", () => {
    // The key stays supported as an override (another machine, a scoped key).
    // Exported, never passed as --api-key, where `ps` could read it.
    expect(common()).toMatch(/export NEON_API_KEY/);
    for (const src of [checkpoint(), rollback()]) {
      expect(src).not.toMatch(/--api-key/);
    }
  });

  it("neither deploy script fetches the key from Infisical", () => {
    for (const path of [FLY_DEPLOY_SH, DATABASE_DEPLOY_SH]) {
      expect(readFileSync(path, "utf8")).not.toMatch(
        /infisical_export_secrets --env infra NEON_API_KEY/,
      );
    }
  });

  it("...but production still refuses to migrate without a checkpoint", () => {
    // The load-bearing half. This is D-95's rule, and the credential change
    // must not have relaxed it: database-deploy.sh (fly-deploy.sh's steps 1–2
    // until the targets were split) still calls the checkpoint on the
    // production path, and the script still exits non-zero when the create
    // fails.
    expect(readFileSync(DATABASE_DEPLOY_SH, "utf8")).toMatch(
      /neon-checkpoint\.sh --parent production/,
    );
    expect(checkpoint()).toMatch(/Failed to create the checkpoint branch/);
    expect(checkpoint()).toMatch(/do NOT bypass the checkpoint/i);
    // The auth failure must name the fix, or the next person hits a dead end
    // in a fail-closed production path.
    expect(common()).toMatch(/neonctl auth/);
  });

  it("no neonctl call can hang an unattended deploy on a prompt", () => {
    // neonctl asks which organization to use when a command has to look across
    // them. Under an API key it never did; under OAuth it can. A prompt in a
    // deploy is worse than an error — it waits forever. Every call redirects
    // stdin, which also stops `branches delete` from eating the prune loop's
    // input on the pipeline that feeds it.
    for (const [name, src] of [
      ["neon-checkpoint.sh", checkpoint()],
      ["neon-rollback.sh", rollback()],
    ] as const) {
      const calls = src
        .split("\n")
        .filter((line) => /"\$\{NEON(?:_CLI)?\[@\]\}"/.test(line))
        // `NEON=("${NEON_CLI[@]}" …)` builds the argv; it does not run it.
        .filter((line) => !/^\s*[A-Z_]+=\(/.test(line))
        // ensure_neon_auth redirects stdin inside the helper, on its own call.
        .filter((line) => !line.includes("ensure_neon_auth"));
      expect(calls.length, `${name}: found no neonctl calls to check`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `${name}: this neonctl call can prompt: ${call.trim()}`).toContain(
          "</dev/null",
        );
      }
    }
  });
});
