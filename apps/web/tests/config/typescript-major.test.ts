import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// TypeScript 7 is the native (Go) compiler, and it cannot be installed here
// yet. This test is what says so, out loud, at the moment someone tries —
// because the way it fails on its own is unreadable.
//
// What happens without this test: `pnpm typecheck` gets FASTER (22s → 3.4s,
// measured), three of four workspaces pass, and `pnpm lint` dies with
// "Failed to load plugin '@typescript-eslint'". typescript-eslint reads
// `ts.versionMajorMinor` at plugin-load time and hard-throws on major >= 7
// (peer range `>=4.8.4 <6.1.0`; support for TS >= 7.1 is tracked upstream at
// typescript-eslint/typescript-eslint#10940). Nothing in that failure mentions
// TypeScript's version.
//
// TypeScript documents a side-by-side mode for exactly this — keep the 6.0 JS
// API available as `@typescript/typescript6` for tools that need it, while
// `tsc` is the 7.0 native build. It does not work in THIS repo, and the reason
// is structural rather than a matter of getting the incantation right:
// `nodeLinker: hoisted` (pnpm-workspace.yaml) gives the tree exactly one
// `node_modules/typescript`. Per-dependency overrides aimed at each of the
// seven @typescript-eslint packages were tried and installed cleanly, and
// changed nothing: with nothing nested to resolve, typescript-eslint still
// reached the one hoisted copy and still saw 7.0. Two TypeScript majors in one
// hoisted tree is not a thing that can be arranged.
//
// So the block is real, it is upstream, and it lifts on someone else's
// schedule. Both assertions below fail when that happens, which is the point:
// nobody has to remember to come back and check.

const repoRoot = resolve(process.cwd(), "..", "..");

const manifest = (relativePath: string): Record<string, Record<string, string>> =>
  JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));

const WORKSPACES = [
  "apps/web/package.json",
  "packages/shared/package.json",
  "packages/livekit-activity-cli/package.json",
  "packages/livekit-captions-agent/package.json",
];

describe("the TypeScript major this repo can actually install", () => {
  it("finds a typescript devDependency in every workspace that declares one", () => {
    // Guards the guard: a renamed manifest would make the check below vacuous.
    const declaring = WORKSPACES.filter((p) => manifest(p).devDependencies?.typescript);
    expect(declaring).toEqual(WORKSPACES);
  });

  it("holds every workspace on the 6.x line, together", () => {
    // Together matters: turbo runs `tsc --noEmit` per workspace, so a single
    // workspace moved to 7 would type-check its own sources with a compiler
    // the linter cannot load, and only that workspace's lint would break.
    for (const path of WORKSPACES) {
      expect(
        manifest(path).devDependencies.typescript,
        `${path} — TypeScript 7 cannot be installed here; see the header of this file`,
      ).toMatch(/^\^?6\./);
    }
  });

  it("fails once typescript-eslint accepts a TypeScript 7, which is what unblocks the upgrade", () => {
    // Read from the INSTALLED package, not from a version string written here:
    // this is a claim about upstream, and the lockfile is the only honest
    // source for it. It changes only when someone bumps typescript-eslint,
    // which is exactly when this question is worth re-asking.
    const peerRange = (
      JSON.parse(
        readFileSync(
          join(repoRoot, "node_modules/@typescript-eslint/eslint-plugin/package.json"),
          "utf8",
        ),
      ) as { peerDependencies: Record<string, string> }
    ).peerDependencies.typescript;

    expect(
      peerRange,
      `typescript-eslint now advertises "${peerRange}" for typescript. If that ` +
        `admits 7.x, the block this file describes has lifted: do the upgrade, ` +
        `and delete this file in the same change rather than widening it.`,
    ).toContain("<6.1.0");
  });
});
