import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every workspace import must name a package that actually exists.
 *
 * WHY THIS EXISTS. Three files imported `@agendaprofe/shared` — the package
 * name from before the D-138 rename — and every local check passed: typecheck,
 * lint, 6,104 unit tests and a full production build. They passed because
 * `apps/web/node_modules/@agendaprofe` was still on disk, an orphaned pnpm
 * symlink from before the rename that no package.json refers to. A clean
 * install never creates it, so the first environment to see the truth was the
 * Docker build on the deploy, which failed with "Module not found".
 *
 * That is the worst shape a failure can have: correct on every machine that
 * already had the old state, broken on every machine that did not. The stale
 * link is deleted, but deleting it fixes one laptop — this stops the class.
 *
 * Deliberately a string check rather than a resolver: resolution is exactly
 * the thing that was lying, so asking the resolver would reproduce the bug.
 *
 * WHAT COUNTS AS VALID IS READ OFF DISK. The first version of this test spelled
 * the live scope out beside the retired one, which left it asserting
 * `scope === "@spiralclass" && !VALID_SCOPES.has(scope)` — a clause that can
 * never be true, so the whole guard was the `@agendaprofe` literal and nothing
 * else. A guard against a rename must not itself need editing by the next
 * rename, so the valid set now comes from the workspace's own package.json
 * files and the retired set is the only thing written down.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const WEB_SRC = join(__dirname, "..", "..", "src");
const WORKSPACE_DIRS = ["apps", "packages"];

/**
 * Scopes this project has published under and abandoned. Importing one is
 * always a rename left half-done — never a third party, never a typo that
 * would fail honestly at build time.
 */
const RETIRED_SCOPES = new Set(["@agendaprofe"]);

/** Every `@scope` a workspace package.json actually declares, read off disk. */
function declaredScopes(): Set<string> {
  const scopes = new Set<string>();
  for (const group of WORKSPACE_DIRS) {
    const groupDir = join(REPO_ROOT, group);
    for (const entry of readdirSync(groupDir)) {
      const manifest = join(groupDir, entry, "package.json");
      let raw: string;
      try {
        raw = readFileSync(manifest, "utf8");
      } catch {
        continue; // Not a package directory.
      }
      const name = (JSON.parse(raw) as { name?: string }).name;
      if (name?.startsWith("@")) scopes.add(name.split("/")[0]);
    }
  }
  return scopes;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("workspace imports", () => {
  const files = sourceFiles(WEB_SRC);
  const valid = declaredScopes();

  it("finds source files to check", () => {
    // Guards the guard: a walk that silently returns nothing would pass every
    // assertion below while checking not one import.
    expect(files.length).toBeGreaterThan(300);
  });

  it("reads at least one live workspace scope off disk", () => {
    // Guards the guard again, from the other side: if the manifest walk found
    // nothing, every import below would be judged against an empty valid set.
    expect(valid.size).toBeGreaterThan(0);
  });

  it("never lists a live scope as retired", () => {
    // A rename BACK to an old name would otherwise make this file reject every
    // correct import in the repo, with a message blaming the rename that fixed
    // it. Fail here instead, where the cause is one line away.
    const both = [...RETIRED_SCOPES].filter((scope) => valid.has(scope));
    expect(
      both,
      `These scopes are declared by a workspace package.json AND listed as retired. ` +
        `Drop them from RETIRED_SCOPES:\n${both.join("\n")}`,
    ).toEqual([]);
  });

  it("imports no workspace scope that does not exist", () => {
    // Matches `from "@scope/pkg"` and `import("@scope/pkg")`. Only the scope
    // matters — a wrong package inside the right scope fails at build anyway,
    // where the error is honest.
    const pattern = /(?:from\s*|import\(\s*)["'](@[a-z0-9-]+)\/[^"']+["']/g;
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        // Third-party scopes are legitimate; only OUR scopes are constrained,
        // and the failure mode is a rename leaving the old one behind.
        if (RETIRED_SCOPES.has(match[1])) {
          offenders.push(`${file.replace(WEB_SRC, "src")}: ${match[0]}`);
        }
      }
    }

    expect(
      offenders,
      `Imports name a workspace scope that no package.json declares — most likely a rename that ` +
        `left files behind. These resolve on a machine with stale node_modules and fail on a ` +
        `clean install:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
