import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLE_ID,
  PRODUCTION_REF,
  deployProtectionProblems,
} from "../../../../scripts/ci/deploy-protection.mjs";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

/**
 * Only the repository owner ships production. That is two GitHub settings (a
 * required reviewer on the `production` environment, and an admin-only
 * `update` rule on the `production` branch), and a setting is not a file, so
 * nothing in the tree fails when one goes. Until 2026-09-23 the docs described
 * the reviewer while the environment had none, and a promote deployed with
 * nobody approving it.
 *
 * So `pnpm promote` reads the live settings through deployProtectionProblems()
 * and refuses without them, and this file holds three things: the check itself,
 * that promote runs it before it pushes, and that what
 * scripts/setup-branch-protection.sh applies is exactly what the check accepts.
 */

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const SETUP = read("scripts", "setup-branch-protection.sh");
const PROMOTE = read("scripts", "ci", "promote.mjs");

const reviewerRule = { type: "required_reviewers", prevent_self_review: false, reviewers: [{}] };

const protectedEnvironment = {
  can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [{ type: "branch_policy" }, reviewerRule],
};

const historyRuleset = {
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: [PRODUCTION_REF], exclude: [] } },
  rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
  bypass_actors: [],
};

const adminOnlyRuleset = {
  ...historyRuleset,
  rules: [{ type: "update" }],
  bypass_actors: [{ actor_id: ADMIN_ROLE_ID, actor_type: "RepositoryRole", bypass_mode: "always" }],
};

const protectedSettings = {
  environment: protectedEnvironment,
  branchPolicies: ["production"],
  rulesets: [historyRuleset, adminOnlyRuleset],
};

describe("deployProtectionProblems", () => {
  it("passes when only the owner can move the branch and approve the deploy", () => {
    expect(deployProtectionProblems(protectedSettings)).toEqual([]);
  });

  it.each([
    ["no environment at all", { environment: null }, /no `production` environment/],
    [
      "no required reviewer — the state production was in until 2026-09-23",
      { environment: { ...protectedEnvironment, protection_rules: [{ type: "branch_policy" }] } },
      /no required reviewer/,
    ],
    [
      "a reviewer rule with nobody in it",
      {
        environment: {
          ...protectedEnvironment,
          protection_rules: [{ ...reviewerRule, reviewers: [] }],
        },
      },
      /no required reviewer/,
    ],
    [
      "self-review prevented, so the only reviewer can never approve",
      {
        environment: {
          ...protectedEnvironment,
          protection_rules: [{ ...reviewerRule, prevent_self_review: true }],
        },
      },
      /prevents self-review/,
    ],
    [
      "admins allowed to bypass the reviewer",
      { environment: { ...protectedEnvironment, can_admins_bypass: true } },
      /Admins can bypass/,
    ],
    [
      "any branch allowed to use the environment",
      {
        environment: {
          ...protectedEnvironment,
          deployment_branch_policy: null,
        },
      },
      /not limited to the `production` branch/,
    ],
    [
      "a second branch allowed to use the environment",
      { branchPolicies: ["production", "main"] },
      /not limited to the `production` branch/,
    ],
    [
      "no admin-only update rule — anyone with write can move production",
      { rulesets: [historyRuleset] },
      /anyone with write access/,
    ],
    [
      "an update rule that anyone with write can bypass",
      {
        rulesets: [
          historyRuleset,
          {
            ...adminOnlyRuleset,
            bypass_actors: [{ actor_id: 4, actor_type: "RepositoryRole", bypass_mode: "always" }],
          },
        ],
      },
      /anyone with write access/,
    ],
    [
      "an update rule that is only evaluated, not enforced",
      { rulesets: [historyRuleset, { ...adminOnlyRuleset, enforcement: "evaluate" }] },
      /anyone with write access/,
    ],
    [
      "the update rule folded into the history ruleset, so admins may force-push",
      {
        rulesets: [
          {
            ...adminOnlyRuleset,
            rules: [{ type: "non_fast_forward" }, { type: "deletion" }, { type: "update" }],
          },
        ],
      },
      /force-pushes and deletion/,
    ],
    ["no history ruleset at all", { rulesets: [adminOnlyRuleset] }, /force-pushes and deletion/],
  ])("refuses %s", (_, override, message) => {
    const problems = deployProtectionProblems({ ...protectedSettings, ...override });
    expect(problems.join("\n")).toMatch(message);
  });

  it("ignores a ruleset that guards some other branch", () => {
    const elsewhere = {
      ...adminOnlyRuleset,
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    };
    expect(
      deployProtectionProblems({ ...protectedSettings, rulesets: [historyRuleset, elsewhere] }),
    ).toHaveLength(1);
  });
});

describe("pnpm promote checks the protection before it moves production", () => {
  it("calls the check, and dies on any problem, before the fast-forward push", () => {
    const check = PROMOTE.indexOf("deployProtectionProblems(");
    const push = PROMOTE.indexOf('run("git", ["push", "origin", `${sha}:refs/heads/production`])');
    expect(check).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(check).toBeLessThan(push);
  });

  it("fails closed when the settings cannot be read", () => {
    expect(PROMOTE).toContain("could not be read");
  });
});

describe("what setup-branch-protection.sh applies is what promote accepts", () => {
  /** A heredoc payload from the script, with its shell variables filled in. */
  function payload(variable: string, vars: Record<string, string>) {
    const body = new RegExp(`${variable}="\\$\\(cat <<JSON\\n([\\s\\S]*?)\\nJSON`).exec(SETUP)?.[1];
    expect(body, `${variable} heredoc`).toBeDefined();
    return JSON.parse(body!.replace(/\$\{(\w+)\}/g, (_, name: string) => vars[name] ?? `$${name}`));
  }

  function environmentPayload() {
    const body = /environments\/production" --input - >\/dev\/null <<JSON\n([\s\S]*?)\nJSON/.exec(
      SETUP,
    )?.[1];
    expect(body, "environment heredoc").toBeDefined();
    return JSON.parse(body!.replace("${OWNER_ID}", "1"));
  }

  it("passes the check as applied", () => {
    const history = payload("RULESET_PAYLOAD", {
      RULESET_NAME: "production: fast-forward only, no delete",
    });
    const adminOnly = payload("UPDATE_RULESET_PAYLOAD", {
      UPDATE_RULESET_NAME: "production: only an admin moves it",
    });
    const env = environmentPayload();

    // Shaped the way GitHub echoes the PUT back, which is what promote reads.
    const environment = {
      can_admins_bypass: env.can_admins_bypass,
      deployment_branch_policy: env.deployment_branch_policy,
      protection_rules: [
        { type: "branch_policy" },
        {
          type: "required_reviewers",
          prevent_self_review: env.prevent_self_review,
          reviewers: env.reviewers,
        },
      ],
    };

    expect(
      deployProtectionProblems({
        environment,
        branchPolicies: ["production"],
        rulesets: [history, adminOnly],
      }),
    ).toEqual([]);
  });

  it("resolves the reviewer's account id at run time rather than writing one down", () => {
    expect(environmentPayload().reviewers).toEqual([{ type: "User", id: 1 }]);
    expect(SETUP).toMatch(/OWNER_ID="\$\(gh api "users\/\$\{REPO%%\/\*\}" --jq \.id\)"/);
  });
});
