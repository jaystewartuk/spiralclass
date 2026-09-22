import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `next lint` was removed in Next.js 16. It does not fail loudly when it goes:
// `next` treats the leftover argument as a directory, so the script dies with
// "Invalid project directory provided, no such directory: apps/web/lint" — a
// message that names a path nobody wrote and says nothing about linting. That
// is what the Next 16 bump PR failed on, and reading the error does not lead
// you to the cause.
//
// Next 15 printed the migration itself ("migrate to the ESLint CLI") while
// still working, which is the window this repo used. The ESLint CLI is
// version-independent, so the script below is correct on 15 and on 16.
//
// `eslint src` is not an arbitrary choice of surface: it is exactly what
// `next lint` linted here. Next's default directory list is app, pages,
// components, lib, src, and `src` is the only one this app has — verified by
// running both commands on the same tree, which reported the identical 20
// findings across the same 12 files. A bare `eslint .` would have widened the
// surface to tests/, which has 527 pre-existing errors and is its own change.

const repoRoot = resolve(process.cwd(), "..", "..");

const packageJsonPaths = execFileSync("git", ["ls-files", "--", "*package.json"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter((line) => line.length > 0 && !line.includes("node_modules"));

const scriptsIn = (relativePath: string): Record<string, string> => {
  const parsed = JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return parsed.scripts ?? {};
};

describe("next lint", () => {
  it("finds the workspace manifests to check", () => {
    // Guards the guard: an empty list would make the assertion below vacuous.
    expect(packageJsonPaths).toContain("apps/web/package.json");
    expect(packageJsonPaths.length).toBeGreaterThan(1);
  });

  it("is not invoked by any workspace script", () => {
    for (const path of packageJsonPaths) {
      for (const [name, command] of Object.entries(scriptsIn(path))) {
        expect(command, `${path} → "${name}" runs a command Next 16 removed`).not.toMatch(
          /\bnext\s+lint\b/,
        );
      }
    }
  });

  it("lints the web app with the ESLint CLI, over the surface next lint covered", () => {
    expect(scriptsIn("apps/web/package.json").lint).toBe("eslint src");
  });
});
