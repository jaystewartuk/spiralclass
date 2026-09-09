import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { partitionFindings } from "../../../../scripts/ci/secret-scan.mjs";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";
import { STEPS } from "../../../../scripts/ci/steps.mjs";

// The credential half of the leak gate (added 2026-09-06).
//
// scripts/check-leaks.mjs is hand-written and repo-specific: it knows a Neon
// project id, an OCID, a free-mail address in a fixture. gitleaks is general
// and deterministic: ~170 curated provider rules plus entropy analysis. Neither
// subsumes the other, and the reason this exists at all is that the
// pre-publication credential pass was a MODEL reading greps — good at the
// contextual half, non-deterministic on high-entropy strings.
//
// What has to hold, and what breaks if it does not:
//
//   1. The scan is scoped to what git would PUBLISH. gitleaks does not respect
//      .gitignore; bare, it reports 15 findings on a clean tree, every one a
//      real credential in a gitignored file it can never publish. A gate that
//      is red on every push is skipped within a week, so this is the difference
//      between a check and a nuisance.
//   2. It is in the registry, not in a workflow. A `run: gitleaks …` in
//      gate.yml would be a second definition of green.
//   3. The allowlist stays justified. An unexplained entry in a credential
//      scanner is indistinguishable from a leak somebody silenced.

const GITLEAKS_TOML = readFileSync(resolve(REPO_ROOT, ".gitleaks.toml"), "utf8");
const GATE_YML = readFileSync(resolve(REPO_ROOT, ".github/workflows/gate.yml"), "utf8");

describe("the scan is scoped to what git would publish", () => {
  // partitionFindings is pure, so the invariant is testable without a gitleaks
  // binary and without planting real credentials in the tree.
  const finding = (File: string) => ({ File, StartLine: 1, RuleID: "github-pat" });

  it("fails on a finding in a file that would be committed", () => {
    const { publishable, excluded } = partitionFindings(
      [finding("apps/web/src/lib/money.ts")],
      () => new Set(),
    );
    expect(publishable).toHaveLength(1);
    expect(excluded).toHaveLength(0);
  });

  it("passes over a finding in a gitignored file", () => {
    // apps/web/.env.local holds 130 real credentials on the operator's machine
    // and is the single reason a bare gitleaks run is unusable here.
    const { publishable, excluded } = partitionFindings(
      [finding("apps/web/.env.local")],
      (paths) => new Set(paths),
    );
    expect(publishable).toHaveLength(0);
    expect(excluded).toHaveLength(1);
  });

  it("still fails on an UNTRACKED file that is not ignored", () => {
    // `git add .` would take it. "Not committed yet" is not "cannot be
    // committed" — only .gitignore makes that distinction, and it is the one
    // this partition asks about.
    const { publishable } = partitionFindings(
      [finding("apps/web/src/lib/scratch.ts")],
      () => new Set(),
    );
    expect(publishable).toHaveLength(1);
  });

  it("reports everything when git cannot answer", () => {
    // An empty ignore-set is the conservative answer: report, do not excuse.
    // The opposite default from check-leaks.mjs's walk, deliberately — there a
    // broken `git check-ignore` would cry wolf, here it would fall silent.
    const { publishable } = partitionFindings([finding("anything")], () => new Set());
    expect(publishable).toHaveLength(1);
  });
});

describe("the scanner is in the registry, not in a workflow", () => {
  it("registers as a fast-tier step that declares its prerequisite", () => {
    const step = STEPS.find((s) => s.id === "secret-scan");
    expect(step, "the secret-scan step is gone from scripts/ci/steps.mjs").toBeTruthy();
    expect(step!.tier).toBe("fast");
    // Without `needs`, a missing binary surfaces as a shell error mid-run
    // instead of gate.mjs refusing up front with an install instruction.
    expect(step!.needs).toContain("gitleaks");
    expect(step!.cmd.join(" ")).toContain("scripts/ci/secret-scan.mjs");
  });

  it("gate.yml installs the tool but never runs the scan itself", () => {
    expect(GATE_YML).toContain("Install gitleaks");
    // Tooling setup is fine; a second definition of the check is not.
    expect(GATE_YML, "gate.yml runs gitleaks directly — that is a restated step").not.toMatch(
      /^\s+run:.*\bgitleaks dir\b/m,
    );
    // As a `uses:`, not anywhere — the comment above the install step names it
    // to say why it was rejected, and a substring check would fail on that.
    expect(GATE_YML, "gitleaks-action RUNS the scan, which restates the check").not.toMatch(
      /^\s*(-\s*)?uses:\s*gitleaks\/gitleaks-action/m,
    );
  });

  it("pins the gitleaks release and verifies its checksum", () => {
    // An unpinned installer piped into a shell is a worse supply-chain edge
    // than the two options this deliberately rejected.
    expect(GATE_YML).toMatch(/GITLEAKS_VERSION:\s*\d+\.\d+\.\d+/);
    expect(GATE_YML).toMatch(/GITLEAKS_SHA256:\s*[0-9a-f]{64}/);
    expect(GATE_YML).toContain("sha256sum -c -");
  });
});

describe("the allowlist stays honest", () => {
  it("every allowlist entry carries a description", () => {
    const blocks = GITLEAKS_TOML.split("[[allowlists]]").slice(1);
    expect(blocks.length, "no allowlists found — did the config move?").toBeGreaterThan(0);
    for (const [i, block] of blocks.entries()) {
      expect(block, `allowlist block ${i + 1} has no description`).toContain("description");
    }
  });

  it("does not allowlist the gitignored credential files wholesale", () => {
    // That would be a second copy of .gitignore, drifting from it silently, and
    // a NEW gitignored secret file would be reported until someone remembered
    // to add it here. The partition asks git instead.
    for (const path of [".env.local", "config/env", ".auth"]) {
      expect(GITLEAKS_TOML, `.gitleaks.toml duplicates .gitignore for ${path}`).not.toContain(path);
    }
  });

  it("scopes the .env.example exception to the empty-assignment shape", () => {
    // Narrow on purpose: a real value pasted into that template, matched by any
    // provider rule, must still fail. A blanket path allowlist would not.
    expect(GITLEAKS_TOML).toContain("apps/web/\\.env\\.example");
    expect(GITLEAKS_TOML).toContain("regexes");
  });
});
