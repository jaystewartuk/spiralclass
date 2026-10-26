/**
 * Whether the repository's settings let only its owner ship production.
 *
 * Two settings together make "only the owner deploys" true, and neither lives
 * in a file. So this module is how the tree checks them. The first is
 * GitHub's, the second is ours:
 *
 *   1. The `production` ENVIRONMENT has a required reviewer, admins cannot
 *      bypass it, and only the `production` branch may use it. Every deploy
 *      run waits for that reviewer before the database job starts, whoever
 *      moved the branch, and whatever credential they used.
 *
 *      The Cloud Run job's values live in a SECOND environment,
 *      `production-app`, with no reviewer ([D-205]): one approval per deploy,
 *      not one per job. It is safe only because that job `needs:` the database
 *      job, so it cannot start until the reviewer approved, and because only
 *      the `production` branch may use that environment either — which is the
 *      half of it this module checks. The `needs:` is held in
 *      apps/web/tests/config/local-gate.test.ts.
 *   2. The `production` BRANCH can be moved only by a repository admin (an
 *      `update` rule whose only bypass is the admin role). It also has a
 *      separate, bypass-free ruleset that stops anyone force-pushing or deleting
 *      it. They are two rulesets because a bypass actor bypasses EVERY rule in
 *      its ruleset, so an admin bypass on the fast-forward ruleset would let an
 *      admin rewrite production's history.
 *
 * Until 2026-09-23 the docs described (1) as live while the environment had no
 * reviewer at all, and a promote deployed with nobody approving it. That gap is
 * the reason this exists. `pnpm promote` calls it before it moves anything, and
 * scripts/setup-branch-protection.sh is what makes it pass.
 *
 * Pure, so a table test can hold it without a network.
 */

/** GitHub's built-in id for the repository `admin` role, as a ruleset bypass actor. */
export const ADMIN_ROLE_ID = 5;

export const PRODUCTION_REF = "refs/heads/production";

/** The environment the Cloud Run job reads its values from, with no reviewer of its own (D-205). */
export const APP_ENVIRONMENT = "production-app";

/**
 * @param {{
 *   environment: any;
 *   branchPolicies: ReadonlyArray<string>;
 *   appEnvironment: any;
 *   appBranchPolicies: ReadonlyArray<string>;
 *   rulesets: ReadonlyArray<any>;
 * }} settings
 *   `environment` is `GET repos/{repo}/environments/production`,
 *   `branchPolicies` the names from its `deployment-branch-policies`,
 *   `appEnvironment` and `appBranchPolicies` the same two for
 *   `production-app`, and `rulesets` every ruleset as
 *   `GET repos/{repo}/rulesets/{id}` returns it.
 * @returns {string[]} What is wrong, one sentence each. Empty means protected.
 */
export function deployProtectionProblems({
  environment,
  branchPolicies,
  appEnvironment,
  appBranchPolicies,
  rulesets,
}) {
  const problems = [];

  if (!environment) {
    return ["There is no `production` environment, so nothing asks anyone before a deploy."];
  }

  const reviewers = (environment.protection_rules ?? []).find(
    (rule) => rule.type === "required_reviewers",
  );
  if (!reviewers || !(reviewers.reviewers ?? []).length) {
    problems.push("The `production` environment has no required reviewer.");
  } else if (reviewers.prevent_self_review === true) {
    // The one maintainer both pushes and approves. With this on, nobody can.
    problems.push(
      "The `production` environment prevents self-review, so its only reviewer can never approve a deploy.",
    );
  }
  if (environment.can_admins_bypass !== false) {
    problems.push("Admins can bypass the `production` environment's reviewer.");
  }

  const onlyProduction = (env, policies) =>
    env.deployment_branch_policy?.custom_branch_policies === true &&
    policies.length === 1 &&
    policies[0] === "production";
  if (!onlyProduction(environment, branchPolicies)) {
    problems.push(
      "The `production` environment's secrets are not limited to the `production` branch.",
    );
  }

  // No reviewer is required here, and one is not refused: it would only bring
  // back the second click D-205 removed. What matters is who can reach it.
  if (!appEnvironment) {
    problems.push(
      `There is no \`${APP_ENVIRONMENT}\` environment, so the Cloud Run job has no credentials to deploy with.`,
    );
  } else if (!onlyProduction(appEnvironment, appBranchPolicies)) {
    problems.push(
      `The \`${APP_ENVIRONMENT}\` environment's secrets are not limited to the \`production\` branch.`,
    );
  }

  const guarding = rulesets.filter(
    (ruleset) =>
      ruleset.target === "branch" &&
      ruleset.enforcement === "active" &&
      (ruleset.conditions?.ref_name?.include ?? []).includes(PRODUCTION_REF),
  );
  const has = (ruleset, type) => (ruleset.rules ?? []).some((rule) => rule.type === type);
  const bypass = (ruleset) => ruleset.bypass_actors ?? [];

  const adminOnlyUpdate = guarding.some(
    (ruleset) =>
      has(ruleset, "update") &&
      bypass(ruleset).length > 0 &&
      bypass(ruleset).every(
        (actor) => actor.actor_type === "RepositoryRole" && actor.actor_id === ADMIN_ROLE_ID,
      ),
  );
  if (!adminOnlyUpdate) {
    problems.push(
      "The `production` branch can be moved by anyone with write access, not only an admin.",
    );
  }

  // Every ruleset on the branch that carries a bypass must be one that cannot
  // also waive the history rules — otherwise the admin-only ruleset becomes a
  // way around them.
  const historyGuarded = guarding.some(
    (ruleset) =>
      has(ruleset, "non_fast_forward") && has(ruleset, "deletion") && bypass(ruleset).length === 0,
  );
  const historyBypassable = guarding.some(
    (ruleset) =>
      (has(ruleset, "non_fast_forward") || has(ruleset, "deletion")) && bypass(ruleset).length > 0,
  );
  if (!historyGuarded || historyBypassable) {
    problems.push(
      "The `production` branch's history is not protected from force-pushes and deletion for everyone, admins included.",
    );
  }

  return problems;
}
