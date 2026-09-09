import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md is agent context, and agent context rots the way documentation
 * rots — silently, and with worse consequences.
 *
 * WHY THIS EXISTS. Every other catalog in this repository is held to the tree:
 * `readme-counts.mjs` recounts the numbers in the front-door documents,
 * `command-catalog.test.ts` proves every `just` recipe resolves to something
 * that exists, `doc-paths` and `doc-links` prove the documentation's pointers
 * do. CLAUDE.md was the one catalog nothing checked, and it is the file with
 * the widest blast radius: it is loaded into EVERY session before anything is
 * read, so a stale line here is not a broken link a reader shrugs at — it is an
 * instruction an agent follows. The failure mode is an agent confidently
 * editing a file that moved two months ago, or running a command that no longer
 * exists, and reporting the error as a repository problem.
 *
 * That is not hypothetical in this tree. Thirteen `just` recipes pointed at a
 * deleted workspace and sat in `just --list` for two days (D-164);
 * 278 documentation paths went dangling across three reorganisations before
 * `doc-paths.test.ts` was written. CLAUDE.md is the same kind of file with none
 * of the same protection.
 *
 * WHAT IT CHECKS, and why each one:
 *
 *   1. A CONTEXT BUDGET. CLAUDE.md is charged to every session, every turn.
 *      Its cost is not the disk it takes, it is the attention it displaces —
 *      a 900-line file is one an agent skims, which is the same as one nobody
 *      wrote. The ceiling is a RATCHET: lower it when the file gets tighter,
 *      never raise it to fit something new. If a section will not fit, it
 *      belongs in `docs/`, which is where the file already sends every reader
 *      for detail.
 *
 *   2. EVERY PATH IT NAMES EXISTS — and the two it names as traps do not.
 *      Markdown links are already covered by `doc-links.test.ts`; this covers
 *      the backticked paths, which is how CLAUDE.md names most code.
 *
 *   3. EVERY `pnpm` COMMAND IT NAMES IS A REAL SCRIPT. Same reasoning as the
 *      justfile catalog: a command in a catalog is a promise, and this one is
 *      made to something that cannot check before it runs.
 *
 *   4. THE OPERATOR-ONLY LIST IS ENFORCED, NOT JUST STATED. CLAUDE.md tells a
 *      session it must never merge, promote or deploy. Prose is the weakest
 *      possible enforcement of a rule about irreversible actions, so the same
 *      list is a `deny` rule in `.claude/settings.json` and a `PreToolUse`
 *      hook. This test is what stops the two copies drifting apart — the
 *      dangerous direction being a command dropped from the deny list while
 *      the sentence promising it is denied stays.
 *
 *   5. THE HOOKS THE SETTINGS DECLARE EXIST AND ARE EXECUTABLE. A hook path
 *      that does not resolve fails open: the harness carries on, nothing is
 *      enforced, and nothing says so. What those hooks actually DO is proved by
 *      `agent-guardrails.test.ts`, which runs them.
 *
 * Not checked here because something else already does it: the Tier 2 path
 * list (`local-gate.test.ts`), `D-NN` citations (`decision-records.test.ts`),
 * `docs/…` paths (`doc-paths.test.ts`), relative links (`doc-links.test.ts`),
 * and whether the things CLAUDE.md says are deleted are still deleted
 * (`local-gate.test.ts` for the mobile tree, `decommissioned-platforms.test.ts`
 * for Supabase and Vercel).
 */

/** Vitest runs from the package root (apps/web). */
const REPO_ROOT = resolve(process.cwd(), "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const CLAUDE_MD = read("CLAUDE.md");

describe("CLAUDE.md stays inside its context budget", () => {
  // A RATCHET. Lower it when the file gets tighter; never raise it.
  //
  // The number is not arbitrary: the file was 885 lines and 8,236 words when
  // this was written, most of it decision history that `docs/decisions/` already
  // owned and product rules `docs/features/` already owned. Compressing it to
  // invariants-plus-pointers took it to 348 lines and 2,675 words. The ceiling
  // sits a little above that — enough room for a genuine new invariant, not
  // enough for a section. When the next one does not fit, the question to ask is
  // which existing line it is more important than, not what the ceiling should
  // be.
  const MAX_LINES = 380;
  const MAX_WORDS = 3600;

  it("is short enough that an agent reads it rather than skims it", () => {
    const lines = CLAUDE_MD.split("\n").length;
    const words = CLAUDE_MD.split(/\s+/).filter(Boolean).length;

    expect(
      lines,
      `CLAUDE.md is ${lines} lines (ceiling ${MAX_LINES}). Move the detail into docs/ and link it.`,
    ).toBeLessThanOrEqual(MAX_LINES);
    expect(
      words,
      `CLAUDE.md is ${words} words (ceiling ${MAX_WORDS}). Move the detail into docs/ and link it.`,
    ).toBeLessThanOrEqual(MAX_WORDS);
  });
});

describe("every path CLAUDE.md names resolves", () => {
  /**
   * The top-level directories a repo-relative path can start with. Anything
   * else in backticks is prose, a bare filename, an identifier or a glob, and
   * cannot be resolved without guessing — guessing is what produces the false
   * positives that get a check like this switched off.
   */
  const ROOTED = /^(apps|packages|docs|scripts|infra|config)\/|^\.(github|githooks|claude)\//;

  /**
   * Paths CLAUDE.md names precisely because they must NOT exist. Asserting the
   * opposite direction keeps the trap itself checkable: `apps/web/middleware.ts`
   * compiles and is silently never invoked, so the day somebody creates it,
   * this fails instead of production quietly losing its CSP header.
   */
  const MUST_NOT_EXIST = ["apps/web/middleware.ts"];

  const named = new Set<string>();
  for (const [, path] of CLAUDE_MD.matchAll(/`([^`\n]+)`/g)) {
    // Trim a trailing `/` (directories are written that way) and any glob tail.
    const candidate = path.replace(/\/\*+.*$/, "").replace(/\/$/, "");
    if (!ROOTED.test(candidate)) continue;
    // A brace expansion names several paths at once; expand it.
    const brace = candidate.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (brace) {
      for (const alt of brace[2].split(","))
        named.add(`${brace[1]}${alt.trim()}${brace[3]}`.replace(/\/$/, ""));
      continue;
    }
    named.add(candidate);
  }

  it("finds paths to check at all", () => {
    // If a rewrite changes how paths are written, this test would pass by
    // checking nothing. Fail loudly instead.
    expect(named.size).toBeGreaterThan(15);
  });

  it("names nothing that has been deleted or moved", () => {
    const missing = [...named]
      .filter((p) => !MUST_NOT_EXIST.includes(p))
      .filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(
      missing,
      `CLAUDE.md points at paths that do not exist:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("still names the traps, and they are still traps", () => {
    for (const path of MUST_NOT_EXIST) {
      expect(CLAUDE_MD, `CLAUDE.md no longer warns about ${path}`).toContain(path);
      expect(existsSync(join(REPO_ROOT, path)), `${path} exists — CLAUDE.md says it must not`).toBe(
        false,
      );
    }
  });
});

describe("every command CLAUDE.md names is runnable", () => {
  type Pkg = { scripts?: Record<string, string> };
  const scriptsOf = (rel: string) => Object.keys((JSON.parse(read(rel)) as Pkg).scripts ?? {});

  const known = new Set([
    ...scriptsOf("package.json"),
    ...scriptsOf("apps/web/package.json"),
    ...scriptsOf("packages/shared/package.json"),
  ]);

  /** pnpm's own verbs, which are not package scripts. */
  const BUILTIN = new Set(["install", "add", "remove", "why", "dlx", "exec", "run", "list"]);

  it("names only scripts that exist in a workspace", () => {
    const referenced = new Set<string>();
    for (const [, script] of CLAUDE_MD.matchAll(/`pnpm ([a-z][a-z0-9:-]*)/g))
      referenced.add(script);

    // `pnpm --filter <ws> <script>` is written with the filter first, so the
    // pattern above skips it by construction; the two examples in the file run
    // `test`, which is covered anyway.
    const unknown = [...referenced].filter((s) => !known.has(s) && !BUILTIN.has(s));
    expect(
      unknown,
      `CLAUDE.md names pnpm scripts that no package.json defines: ${unknown.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * The rule "a session opens a PR, it does not merge, deploy or promote" is the
 * single most consequential thing CLAUDE.md says, and until 2026-09 it was said
 * ONLY in prose — which means it held exactly as long as a model's attention
 * did. These commands move real money, touch production data, or hand out the
 * operator's credentials, and none of them has an undo worth the name.
 *
 * So the rule exists three times on purpose, and this is what keeps the three
 * in step: stated in CLAUDE.md, denied in `.claude/settings.json`, and blocked
 * by the PreToolUse hook (which sees the whole command line, so it catches the
 * shapes a permission pattern cannot — `SKIP_GATE=1 git push`, a bypass flag,
 * a script invoked through `bash`).
 */
describe("the operator-only rule is enforced, not merely stated", () => {
  const SETTINGS = JSON.parse(read(".claude", "settings.json")) as {
    permissions?: { deny?: string[]; allow?: string[] };
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  };
  const deny = (SETTINGS.permissions?.deny ?? []).join("\n");

  /** The command, and the substring the deny rules must contain for it. */
  const OPERATOR_ONLY = [
    "pnpm promote",
    "gh pr merge",
    "pnpm ship:preview",
    "pnpm deploy:preview",
    "scripts/fly-deploy.sh",
    "migrate:prod",
    "infisical",
  ];

  it("CLAUDE.md still names every operator-only command", () => {
    for (const cmd of OPERATOR_ONLY) {
      expect(CLAUDE_MD, `CLAUDE.md no longer names ${cmd} as operator-only`).toContain(cmd);
    }
  });

  it(".claude/settings.json denies every one of them", () => {
    for (const cmd of OPERATOR_ONLY) {
      expect(deny, `${cmd} is called operator-only but nothing denies it`).toContain(cmd);
    }
  });

  // The third copy of the rule — the PreToolUse hook — is not asserted here by
  // reading it. `agent-guardrails.test.ts` EXECUTES it against real payloads,
  // which is the only way to know a regex in a file the gate never runs still
  // does what it says. Greping a hook for keywords proves nothing: the
  // credential rule was present, spelled correctly, and unreachable.

  it("every hook the settings declare exists and is executable", () => {
    const commands = Object.values(SETTINGS.hooks ?? {})
      .flat()
      .flatMap((matcher) => matcher.hooks ?? [])
      .map((hook) => hook.command ?? "")
      .filter(Boolean);

    expect(commands.length, "settings.json declares no hooks").toBeGreaterThan(0);

    for (const command of commands) {
      // Hooks are declared as `$CLAUDE_PROJECT_DIR/.claude/hooks/<name>`.
      const rel = command.replace("$CLAUDE_PROJECT_DIR/", "").split(/\s/)[0];
      expect(rel.startsWith(".claude/hooks/"), `hook is not a repo script: ${command}`).toBe(true);
      expect(existsSync(join(REPO_ROOT, rel)), `hook script is missing: ${rel}`).toBe(true);
      // A non-executable hook fails open — the harness carries on and nothing
      // is enforced, which is the worst of both worlds.
      expect(
        statSync(join(REPO_ROOT, rel)).mode & 0o111,
        `hook script is not executable: ${rel}`,
      ).toBeGreaterThan(0);
    }
  });
});
