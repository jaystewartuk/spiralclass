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

/**
 * @param {{
 *   environment: any;
 *   branchPolicies: ReadonlyArray<string>;
 *   rulesets: ReadonlyArray<any>;
 * }} settings
 *   `environment` is `GET repos/{repo}/environments/production`,
 *   `branchPolicies` the names from its `deployment-branch-policies`, and
 *   `rulesets` every ruleset as `GET repos/{repo}/rulesets/{id}` returns it.
 * @returns {string[]} What is wrong, one sentence each. Empty means protected.
 */
export function deployProtectionProblems({ environment, branchPolicies, rulesets }) {
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

  const policy = environment.deployment_branch_policy;
  const onlyProduction =
    policy?.custom_branch_policies === true &&
    branchPolicies.length === 1 &&
    branchPolicies[0] === "production";
  if (!onlyProduction) {
    problems.push(
      "The `production` environment's secrets are not limited to the `production` branch.",
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
