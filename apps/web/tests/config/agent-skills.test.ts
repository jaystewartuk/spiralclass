import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The project skills under `.claude/skills/` are instructions a session
 * follows, and they rot the way CLAUDE.md does.
 *
 * WHY THIS EXISTS. `claude-md.test.ts` holds CLAUDE.md to the tree; nothing
 * held the skills. A skill is worse to leave unchecked than a document: it is
 * loaded at the moment a session is about to act, and a stale path or a
 * dropped rule is followed rather than questioned.
 *
 * `/issue` is the sharpest case. The repository is public, so filing an issue
 * publishes it. The skill's value is a handful of rules — ask first, keep
 * security out of public issues, never close anything — and each is one
 * careless edit from gone, with no other check to notice. Those rules are
 * pinned below. The labels it names are checked in `github-labels.test.ts`,
 * beside the list of labels that exist.
 */

/** Vitest runs from the package root (apps/web). */
const REPO_ROOT = resolve(process.cwd(), "..", "..");
const SKILLS = join(REPO_ROOT, ".claude", "skills");
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const skillNames = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const skill = (name: string) => read(".claude", "skills", name, "SKILL.md");

/** The contents of fenced code blocks — the commands a session will run. */
const commandsIn = (source: string) =>
  [...source.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!).join("\n");

describe("every project skill is well-formed", () => {
  it("finds the skills at all", () => {
    expect(skillNames).toEqual(expect.arrayContaining(["issue", "pr"]));
  });

  it.each(skillNames)("%s has a SKILL.md whose name matches its directory", (name) => {
    expect(existsSync(join(SKILLS, name, "SKILL.md"))).toBe(true);
    const front = /^---\n([\s\S]*?)\n---/.exec(skill(name))?.[1] ?? "";
    expect(front, `${name}/SKILL.md has no frontmatter`).not.toBe("");
    expect(/^name:\s*(.+)$/m.exec(front)?.[1]?.trim()).toBe(name);
    // The description is what the harness matches a request against; an empty
    // one is a skill nothing ever invokes.
    expect(/^description:\s*(.+)$/m.exec(front)?.[1]?.trim().length ?? 0).toBeGreaterThan(40);
  });

  it.each(skillNames)("every path %s names resolves", (name) => {
    const source = skill(name);
    const rooted = [...source.matchAll(/`([^`\n\s<>]+)`/g)]
      .map((m) => m[1]!.replace(/:\d+$/, "").replace(/\/$/, ""))
      .filter((p) =>
        /^(apps|packages|docs|scripts|infra|config)\/|^\.(github|githooks|claude)\//.test(p),
      );
    const linked = [...source.matchAll(/\]\((\.[^)#\s]+)(?:#[^)]*)?\)/g)].map((m) =>
      join(dirname(join(".claude", "skills", name, "SKILL.md")), m[1]!),
    );
    const missing = [...rooted, ...linked].filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(missing, `${name}/SKILL.md points at paths that do not exist`).toEqual([]);
  });
});

describe("/issue keeps the rules that make filing safe on a public repository", () => {
  const source = skill("issue");
  const commands = commandsIn(source);

  it("searches closed issues as well as open ones", () => {
    // An open-only search cannot see that the same work was already done, or
    // already declined — the two duplicates most worth catching.
    expect(commands).toMatch(/gh issue list --state all/);
    expect(commands).not.toMatch(/gh issue list(?![^\n]*--state all)/);
  });

  it("files only after the user approves the draft", () => {
    expect(source).toMatch(/### \d\. Show the draft, then file/);
    expect(source).toMatch(/only on a yes/);
    // The create command appears after the approval step, not before it. Prose
    // earlier in the file names the command; the fenced one is what runs.
    const create = source.search(/```bash\ngh issue create/);
    expect(create, "no fenced gh issue create command").toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(source.indexOf("Show the draft, then file"));
  });

  it("sends security problems to the private channel, never a public issue", () => {
    expect(source).toContain("SECURITY.md");
    expect(source).toMatch(/\*\*never\*\* a public issue/);
  });

  it("never runs a command that changes an existing issue or creates a label", () => {
    for (const verb of ["close", "delete", "edit", "transfer", "lock", "reopen", "pin"]) {
      expect(commands, `/issue runs gh issue ${verb}`).not.toContain(`gh issue ${verb}`);
    }
    expect(commands).not.toContain("gh label create");
  });

  it("writes the body to a file, where the shell cannot eat backticks and $", () => {
    expect(commands).toMatch(/gh issue create[^\n]*--body-file/);
    expect(commands).not.toMatch(/gh issue create[^\n]*--body /);
  });

  it("requires a Done when line", () => {
    expect(source).toContain("**Done when**");
  });
});

describe("/pr closes the loop /issue opens", () => {
  it("tells a session to write Closes #N when a PR finishes an issue", () => {
    // D-172 chose Issues because a merged PR closes one without anybody
    // editing a list. That only holds if the PR says so.
    expect(skill("pr")).toContain("Closes #N");
  });
});
