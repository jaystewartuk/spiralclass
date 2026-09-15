import { execFileSync, spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./_tree";

/**
 * Every `infra/**` template ships as `<name>.example`, and the filled-in copy
 * beside it holds a real account identifier: the Cloudflare account id in
 * `backend.hcl` and `terraform.tfvars`, the Infisical project id in
 * `.infisical.json`. They were templated on 2026-09-04 ahead of the repository
 * going public (D-158) — but `.gitignore` still carried a negation from when
 * `infra/cloudflare-r2/terraform.tfvars` was committed on purpose, so the
 * README's own `cp terraform.tfvars.example terraform.tfvars` produced a file
 * git offered to commit.
 *
 * The list is derived from the tracked templates rather than kept here, so a
 * new `.example` is covered by the commit that adds it.
 */

const git = (args: string[]) =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

const TEMPLATES = git(["ls-files", "--", "infra/**/*.example", "infra/*.example"]);

/** `git check-ignore` on a path that need not exist, ignoring the index. */
const ignored = (path: string) =>
  spawnSync("git", ["check-ignore", "-q", "--no-index", "--", path], { cwd: REPO_ROOT }).status ===
  0;

describe("the filled-in copy of every infra template is gitignored", () => {
  it("finds the templates it guards", () => {
    // A glob that matched nothing would pass every case below vacuously.
    expect(TEMPLATES).toEqual(
      expect.arrayContaining([
        "infra/backend.hcl.example",
        "infra/cloudflare-r2/terraform.tfvars.example",
        "infra/infisical/.infisical.json.example",
      ]),
    );
  });

  it.each(TEMPLATES.map((template) => [template.replace(/\.example$/, ""), template]))(
    "%s is ignored",
    (filled, template) => {
      expect(ignored(filled), `${filled} (from ${template}) is not gitignored`).toBe(true);
    },
  );

  it("none of them is tracked", () => {
    const filled = TEMPLATES.map((template) => template.replace(/\.example$/, ""));
    expect(git(["ls-files", "--", ...filled])).toEqual([]);
  });
});
