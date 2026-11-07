import { accessSync, constants, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Codex reads `AGENTS.md` and `.codex/`; Claude Code reads `CLAUDE.md` and
 * `.claude/`. The first Codex setup here was a find-and-replace copy of both,
 * untracked. It told a session that `.Codex/settings.json` and
 * `Codex-md.test.ts` existed, and fresh worktrees did not get it at all.
 *
 * So there is one source and everything else points at it: the context and the
 * hooks are symlinks. A subagent cannot be a symlink, because the formats
 * differ, so its text is compared. The hook wiring cannot be a symlink either,
 * so its events, matchers and scripts are compared.
 *
 * ⚠️ This proves the files agree. It cannot prove that Codex runs the hooks:
 * Codex skips a hook nobody has trusted, without saying so. See
 * docs/development/ai-assisted-engineering.md.
 */

/** Vitest runs from the package root (apps/web). */
const REPO_ROOT = resolve(process.cwd(), "..", "..");
const path = (...parts: string[]) => join(REPO_ROOT, ...parts);
const read = (...parts: string[]) => readFileSync(path(...parts), "utf8");

type HookEntry = { matcher?: string; hooks: { type: string; command: string }[] };
type HookConfig = { hooks: Record<string, HookEntry[]> };

const SCRIPT_NAME = /([\w-]+\.sh)\b/;

/** `event|matcher|script` for every hook, so that two configs can be compared. */
function wiring(config: HookConfig): string[] {
  return Object.entries(config.hooks)
    .flatMap(([event, entries]) =>
      entries.flatMap((entry) =>
        entry.hooks.map(
          (hook) => `${event}|${entry.matcher ?? ""}|${hook.command.match(SCRIPT_NAME)?.[1]}`,
        ),
      ),
    )
    .sort();
}

const claudeHooks = JSON.parse(read(".claude/settings.json")) as HookConfig;
const codexHooks = JSON.parse(read(".codex/hooks.json")) as HookConfig;

describe("AGENTS.md", () => {
  it("is a symlink to CLAUDE.md, so that the two cannot disagree", () => {
    expect(lstatSync(path("AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path("AGENTS.md"))).toBe("CLAUDE.md");
  });
});

describe(".codex/hooks", () => {
  it("wires the same scripts to the same events as .claude/settings.json", () => {
    expect(wiring(claudeHooks).length).toBeGreaterThanOrEqual(3);
    expect(wiring(codexHooks)).toEqual(wiring(claudeHooks));
  });

  it("runs every hook through a repo-relative path", () => {
    // An absolute path breaks in a worktree, and in a public repository it
    // publishes a home directory.
    const commands = Object.values(codexHooks.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const command of commands) {
      expect(command).toMatch(
        /^"\$\(git rev-parse --show-toplevel\)\/\.codex\/hooks\/[\w-]+\.sh"$/,
      );
    }
  });

  it("holds only symlinks to the executable .claude/hooks scripts", () => {
    const names = readdirSync(path(".codex/hooks")).sort();
    expect(names).toEqual(readdirSync(path(".claude/hooks")).sort());
    for (const name of names) {
      expect(lstatSync(path(".codex/hooks", name)).isSymbolicLink(), name).toBe(true);
      expect(readlinkSync(path(".codex/hooks", name))).toBe(`../../.claude/hooks/${name}`);
      // Throws if the link is dangling, or if its target cannot be executed. A
      // hook that cannot run fails open.
      accessSync(path(".codex/hooks", name), constants.X_OK);
    }
  });
});

describe(".codex/agents", () => {
  const agents = readdirSync(path(".claude/agents")).map((file) => file.replace(/\.md$/, ""));

  it("has a counterpart for every .claude agent, and no others", () => {
    expect(agents.length).toBeGreaterThanOrEqual(1);
    const codex = readdirSync(path(".codex/agents")).map((file) => file.replace(/\.toml$/, ""));
    expect(codex.sort()).toEqual([...agents].sort());
  });

  it.each(agents)("%s says the same thing in both formats", (name) => {
    const [, frontmatter, markdownBody] = read(".claude/agents", `${name}.md`).split(/^---$/m);
    const toml = read(".codex/agents", `${name}.toml`);

    expect(toml.match(/^name = "(.*)"$/m)?.[1]).toBe(name);
    expect(toml.match(/^description = "(.*)"$/m)?.[1]).toBe(
      frontmatter.match(/^description: (.*)$/m)?.[1],
    );
    expect(toml.match(/^developer_instructions = """\n([\s\S]*?)"""/m)?.[1].trim()).toBe(
      markdownBody.trim(),
    );
  });
});
