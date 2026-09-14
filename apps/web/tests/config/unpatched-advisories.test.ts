import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./_tree";

/**
 * Advisories with NO patched release, which no override can close.
 *
 * Everything `pnpm-workspace.yaml` can fix, it fixes with an override. These
 * are the other kind: the vulnerable range reaches the latest version, so the
 * only remedy is to not resolve the package at all. The audit step cannot hold
 * that line on its own — it grades `--prod --audit-level high`, and a
 * moderate or dev-tree finding sails under it — so this reads the lockfile.
 *
 * extract-zip (GHSA-jmr9-qjv8-65gv, symlink path traversal, <=2.0.1, no fix)
 * arrived through @lhci/cli > lighthouse > puppeteer-core > @puppeteer/browsers.
 * Nothing ran Lighthouse CI — no step in scripts/ci/steps.mjs, no workflow —
 * so it was retired rather than kept for a zip extractor to ride in on. If
 * this fails, something has pulled that chain (or another) back in: remove the
 * dependency, or wait for a patched release and move the bound.
 */
const UNPATCHED: ReadonlyArray<{ name: string; maxVulnerable: string; ghsa: string }> = [
  { name: "extract-zip", maxVulnerable: "2.0.1", ghsa: "GHSA-jmr9-qjv8-65gv" },
];

/** Every `name@version` the lockfile's `packages:` section resolves. */
function resolvedVersions(lockfile: string): Map<string, string[]> {
  const start = lockfile.indexOf("\npackages:\n");
  const end = lockfile.indexOf("\nsnapshots:\n");
  const section = lockfile.slice(start, end === -1 ? undefined : end);
  const versions = new Map<string, string[]>();
  for (const match of section.matchAll(/^ {2}'?((?:@[^/\s]+\/)?[^@\s']+)@([^:'(\s]+)'?:/gm)) {
    const [, name, version] = match as unknown as [string, string, string];
    versions.set(name, [...(versions.get(name) ?? []), version]);
  }
  return versions;
}

/** Numeric major.minor.patch comparison; a prerelease counts as its release. */
function atOrBelow(version: string, bound: string): boolean {
  const parse = (v: string) => v.split(/[-+]/)[0]!.split(".").map(Number);
  const [a, b] = [parse(version), parse(bound)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return true;
}

describe("the lockfile resolves no package with an unpatched advisory", () => {
  const versions = resolvedVersions(readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8"));

  it("reads the lockfile it claims to (a parser that finds nothing would pass vacuously)", () => {
    expect(versions.get("next")?.length ?? 0).toBeGreaterThan(0);
    expect(versions.get("@prisma/client")?.length ?? 0).toBeGreaterThan(0);
  });

  it.each(UNPATCHED)(
    "$name is not resolved at <=$maxVulnerable ($ghsa)",
    ({ name, maxVulnerable, ghsa }) => {
      const vulnerable = (versions.get(name) ?? []).filter((v) => atOrBelow(v, maxVulnerable));
      expect(
        vulnerable,
        `pnpm-lock.yaml resolves ${name}@${vulnerable.join(", ")}, covered by ${ghsa} with no ` +
          `patched release. Run \`pnpm why -r ${name}\` and remove whatever brought it back.`,
      ).toEqual([]);
    },
  );

  it("compares versions the way the bound means", () => {
    expect(atOrBelow("2.0.1", "2.0.1")).toBe(true);
    expect(atOrBelow("1.7.0", "2.0.1")).toBe(true);
    expect(atOrBelow("2.0.2", "2.0.1")).toBe(false);
    expect(atOrBelow("10.0.0", "2.0.1")).toBe(false);
    expect(
      resolvedVersions("\npackages:\n\n  extract-zip@2.0.1:\n    x\n\nsnapshots:\n").get(
        "extract-zip",
      ),
    ).toEqual(["2.0.1"]);
    expect(resolvedVersions("\npackages:\n\n  '@a/b@1.0.0':\n\nsnapshots:\n").get("@a/b")).toEqual([
      "1.0.0",
    ]);
  });
});
