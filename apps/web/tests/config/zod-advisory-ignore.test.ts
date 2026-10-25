import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, walkTree } from "./_tree";

// pnpm-workspace.yaml carries ONE audit ignore, GHSA-mrhx-c7xc-m3w5: zod's v4
// array parser can be made to exhaust memory, and the advisory range ("<4.6.6")
// swallows the workspace's own zod@3.25.x, which has no patched release. It is
// safe to carry only while the vulnerable code - `zod/v4/core`, which 3.25.x
// ships beside the v3 API - is never loaded. These are the three things that
// have to stay true for that, so the ignore cannot outlive its reason.

const workspace = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
const lockfile = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

describe("the zod audit ignore stays justified", () => {
  it("is the only entry in ignoreGhsas", () => {
    const block = workspace.split(/^auditConfig:/m)[1] ?? "";
    const ids = [...block.matchAll(/^\s+-\s+(GHSA-[\w-]+)/gm)].map((m) => m[1]);
    expect(ids).toEqual(["GHSA-mrhx-c7xc-m3w5"]);
  });

  it("nothing in the workspace imports the zod v4 entry points", () => {
    const sources = walkTree(
      REPO_ROOT,
      (name) => /\.(ts|tsx|mts|mjs|js)$/.test(name) && name !== "zod-advisory-ignore.test.ts",
    ).filter((f) => !f.includes("/node_modules/"));
    const offenders = sources.filter((f) =>
      /from\s+["']zod\/(v4|mini)|require\(["']zod\/(v4|mini)|@anthropic-ai\/sdk\/helpers/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("no zod 4.x below the patched 4.6.6 is installed", () => {
    const versions = [...lockfile.matchAll(/^ {2}zod@(\d+)\.(\d+)\.(\d+):/gm)].map((m) => [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
    ]);
    const vulnerable4 = versions.filter(
      ([major, minor, patch]) => major === 4 && (minor < 6 || (minor === 6 && patch < 6)),
    );
    expect(vulnerable4).toEqual([]);
  });
});
