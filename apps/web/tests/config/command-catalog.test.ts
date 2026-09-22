import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// The `justfile` is the human-facing catalog of this repo's commands — CLAUDE.md
// says so, and `just --list` is what a newcomer (or an agent) reads to find out
// what can be run. `mprocs.yaml` is the same idea for long-lived dev processes:
// `just dev` launches every pane in it at once.
//
// Neither is executed by any test, linted, or type-checked. A recipe that
// invokes a deleted script is therefore invisible until somebody runs it, and
// what they get is a bare `ERR_PNPM_NO_SCRIPT` or "no such file" with no hint
// that the recipe was never going to work.
//
// That is not hypothetical. When a whole workspace was deleted, THIRTEEN
// recipes were left behind pointing at things that no longer existed — a
// workspace, a build script, a helper and six root `pnpm` aliases. They sat in
// `just --list`, advertised as available, for two days across every session
// that read the catalog, and `mprocs.yaml` opened a failing pane on every
// single `just dev`. D-164 removed them and added this.
//
// So: every command the catalog advertises must resolve to something that
// exists. This is a spelling check, not an execution check — it proves the
// target is there, never that running it succeeds.

type Pkg = { scripts?: Record<string, string> };

const readPkg = (relPath: string): Pkg =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), "utf8")) as Pkg;

const rootScripts = new Set(Object.keys(readPkg("package.json").scripts ?? {}));

/** Workspace package name → its own scripts. Mirrors pnpm-workspace.yaml. */
const WORKSPACES: ReadonlyArray<readonly [string, string]> = [
  ["spiralclass-web", "apps/web/package.json"],
  ["@spiralclass/shared", "packages/shared/package.json"],
  ["@spiralclass/livekit-activity-cli", "packages/livekit-activity-cli/package.json"],
  ["@spiralclass/livekit-captions-agent", "packages/livekit-captions-agent/package.json"],
];

const workspaceScripts = new Map<string, Set<string>>(
  WORKSPACES.map(([name, path]) => [name, new Set(Object.keys(readPkg(path).scripts ?? {}))]),
);

/** Files whose command references are checked. Both are catalogs, not code. */
const CATALOGS = ["justfile", "mprocs.yaml"] as const;

/**
 * A `just` parameter (`{{FILE}}`) or a shell variable can't be resolved
 * statically, so a reference containing one is skipped rather than guessed at.
 */
const isDynamic = (token: string) => token.includes("{{") || token.includes("$");

type Ref = { file: string; line: number; text: string; problem: string };

function checkCatalog(relPath: string): Ref[] {
  const problems: Ref[] = [];
  const lines = readFileSync(resolve(REPO_ROOT, relPath), "utf8").split("\n");

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith("#")) return;

    const report = (problem: string) =>
      problems.push({ file: relPath, line: index + 1, text: line, problem });

    // `pnpm --filter <package> <script>` — the package must be a real workspace
    // and the script must exist inside it. A filter that matches no package is
    // the failure mode that is easiest to miss: pnpm exits 0 having run nothing.
    // Script names are `[\w:.-]+` (`db:test:up`, `test:visual:regression`) — the
    // character class must exclude the quotes that wrap a command in YAML.
    for (const m of line.matchAll(/pnpm\s+--filter\s+([@\w./-]+)\s+([A-Za-z][\w:.-]*)/g)) {
      const [, pkg, script] = m;
      if (isDynamic(pkg) || isDynamic(script)) continue;
      const scripts = workspaceScripts.get(pkg);
      if (!scripts) {
        report(`--filter names "${pkg}", which is not a workspace package`);
        continue;
      }
      if (!scripts.has(script)) {
        report(`"${pkg}" has no script "${script}"`);
      }
    }

    // `pnpm <script>` — a root alias. Skipped when it is really the --filter
    // form (handled above) or a flag.
    for (const m of line.matchAll(/pnpm\s+([a-z][\w:-]*)/g)) {
      const script = m[1];
      if (script === "filter" || isDynamic(script)) continue;
      if (line.includes(`pnpm --filter`) && !rootScripts.has(script)) continue;
      if (!rootScripts.has(script)) {
        report(`root package.json has no script "${script}"`);
      }
    }

    // `bash <path>` / `node <path>`, and any bare repo-relative script path.
    for (const m of line.matchAll(/(?:^|\s)(?:bash|sh|node)\s+([\w./-]+\.(?:sh|mjs|js|ts))/g)) {
      const path = m[1];
      if (isDynamic(path)) continue;
      if (!existsSync(resolve(REPO_ROOT, path))) {
        report(`invokes "${path}", which does not exist`);
      }
    }
    for (const m of line.matchAll(/(?:^|\s)((?:scripts|infra|apps|packages)\/[\w./-]+\.sh)/g)) {
      const path = m[1];
      if (isDynamic(path)) continue;
      if (!existsSync(resolve(REPO_ROOT, path))) {
        report(`invokes "${path}", which does not exist`);
      }
    }
  });

  // The `bash <path>` and bare-path patterns overlap on `bash scripts/x.sh`;
  // one missing file is one problem, not two.
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.line}:${p.problem}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

describe("the command catalog only advertises commands that exist", () => {
  it.each(CATALOGS)("%s references nothing that has been deleted", (relPath) => {
    const problems = checkCatalog(relPath);

    const detail = problems
      .map((p) => `  ${p.file}:${p.line} — ${p.problem}\n    ${p.text}`)
      .join("\n\n");

    expect(
      problems,
      problems.length
        ? `${relPath} advertises ${problems.length} command(s) that cannot run:\n\n${detail}\n\n` +
            `Delete the recipe, or point it at something that exists. A catalog entry ` +
            `that fails on invocation is worse than a missing one.\n`
        : "",
    ).toEqual([]);
  });

  // Guards the guard: if the workspace list above goes stale, every --filter
  // check silently degrades into "not a workspace package" noise, or worse,
  // a package is dropped and its recipes stop being checked at all.
  it.each(WORKSPACES)("%s is still a real workspace", (_name, pkgPath) => {
    expect(existsSync(resolve(REPO_ROOT, pkgPath)), `${pkgPath} is missing`).toBe(true);
  });
});
