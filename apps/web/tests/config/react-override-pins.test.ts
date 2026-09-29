import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// The React versions this repo installs are decided by `overrides:` in
// pnpm-workspace.yaml, not by any package.json. A manifest that names a
// different version is simply ignored: pnpm records the OVERRIDDEN specifier
// in the lockfile, so `--frozen-lockfile` sees nothing wrong and the tree
// stays on the pinned version.
//
// That made every Dependabot bump of one of these four packages inert. #1104
// merged one on 2026-09-06 and changed nothing but the manifest, which then
// claimed react 19.2.8 over an installed 19.2.3 for three weeks; #101 proposed
// the same for react-dom. The comment above the overrides said to keep the two
// in step by hand. This is that sentence, made executable: a bump has to move
// the override and every manifest together, or it fails here instead of
// merging a lie.

const PINNED = ["react", "react-dom", "@types/react", "@types/react-dom"] as const;

function overridePins(): Record<string, string> {
  const yaml = readFileSync(resolve(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = yaml.split(/^overrides:\s*$/m)[1]?.split(/^\S/m)[0] ?? "";
  const pins: Record<string, string> = {};
  for (const name of PINNED) {
    const key = name.startsWith("@") ? `"${name}"` : name;
    const escaped = key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const match = block.match(new RegExp(`^\\s+${escaped}:\\s*"?([^"\\s#]+)`, "m"));
    if (match) pins[name] = match[1]!;
  }
  return pins;
}

function workspaceManifests(): string[] {
  const manifests = [resolve(REPO_ROOT, "package.json")];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(resolve(REPO_ROOT, group), { withFileTypes: true })) {
      if (entry.isDirectory()) manifests.push(join(REPO_ROOT, group, entry.name, "package.json"));
    }
  }
  return manifests;
}

describe("React override pins", () => {
  const pins = overridePins();

  it("pins all four React packages in pnpm-workspace.yaml", () => {
    expect(Object.keys(pins).sort()).toEqual([...PINNED].sort());
  });

  it("every manifest names exactly the version the override installs", () => {
    const disagreements: string[] = [];
    for (const path of workspaceManifests()) {
      let manifest: Record<string, Record<string, string> | undefined>;
      try {
        manifest = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue; // a directory with no package.json is not a workspace
      }
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const name of PINNED) {
          const declared = manifest[field]?.[name];
          if (declared !== undefined && declared !== pins[name]) {
            disagreements.push(
              `${path.slice(REPO_ROOT.length + 1)} ${field}.${name} is ${declared}, override installs ${pins[name]}`,
            );
          }
        }
      }
    }
    expect(
      disagreements,
      "Move the override in pnpm-workspace.yaml and every manifest together.",
    ).toEqual([]);
  });
});
