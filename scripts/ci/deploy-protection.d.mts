// Types for the production deploy-protection check (scripts/ci/deploy-protection.mjs).
// Sibling declaration for the same reason deploy-verdict.d.mts is one: the
// module stays a plain runnable .mjs with no build step, while the guard test
// (apps/web/tests/config/production-access.test.ts) imports it with full types.

/** GitHub's built-in id for the repository `admin` role, as a ruleset bypass actor. */
export const ADMIN_ROLE_ID: number;

export const PRODUCTION_REF: string;

export interface DeployProtectionSettings {
  /** `GET repos/{repo}/environments/production`, or null when it does not exist. */
  environment: unknown;
  /** The branch-policy names from the environment's `deployment-branch-policies`. */
  branchPolicies: ReadonlyArray<string>;
  /** Every ruleset, as `GET repos/{repo}/rulesets/{id}` returns it. */
  rulesets: ReadonlyArray<unknown>;
}

/** What is wrong, one sentence each. Empty means only the owner can ship production. */
export function deployProtectionProblems(settings: DeployProtectionSettings): string[];
