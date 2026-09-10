import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// GitHub fails silently when a config file names a label the repository does
// not have. Dependabot leaves a comment on the pull request — "The following
// labels could not be found: `ci`, `dependencies`. Please create them before
// Dependabot can add them to a pull request." — and opens it unlabelled; an
// issue template simply applies nothing. Neither is a failed check, so the only
// way to find out is to read a bot comment on a PR nobody was watching. This
// repository shipped exactly that: `dependencies` and `ci` were named here from
// the first commit and did not exist, so every dependency PR arrived unlabelled
// and the filter that was supposed to find them matched nothing.
//
// So the names live here too. REPO_LABELS mirrors the labels that exist on the
// repository; naming anything else under .github/ fails this test instead of
// failing quietly on GitHub. Adding a label is two things in the same change:
// the name below, and `gh label create <name>` against the repo.

const REPO_LABELS = new Set([
  // Created with the repository by GitHub.
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
  // Created by hand, and only real because someone ran `gh label create`.
  "accessibility",
  "ci",
  "dependencies",
  // Created by Dependabot itself, unasked, the first time a security advisory
  // opened a pip PR. It creates its own ecosystem labels; it will not create
  // the ones dependabot.yml asks for, which is the whole point of this file.
  "python",
]);

const repoRoot = resolve(process.cwd(), "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");

/**
 * Both spellings GitHub accepts: an inline `labels: ["bug"]` as the issue
 * templates write it, and a block list as dependabot.yml writes it.
 */
function labelsIn(source: string): string[] {
  const found: string[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const inline = /^\s*labels:\s*\[(.*)\]\s*$/.exec(lines[i]!);
    if (inline) {
      found.push(...inline[1]!.split(",").map(unquote).filter(Boolean));
      continue;
    }

    if (!/^\s*labels:\s*$/.test(lines[i]!)) continue;

    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (/^\s*#/.test(line)) continue; // a comment between items, not the end of the list
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (!item) break;
      found.push(unquote(item[1]!));
    }
  }

  return found;
}

const issueTemplates = readdirSync(join(repoRoot, ".github", "ISSUE_TEMPLATE")).filter((name) =>
  name.endsWith(".yml"),
);

describe("labels named in .github/", () => {
  it("parses the labels out of dependabot.yml", () => {
    // Guards the guard: a parser that quietly returns nothing would make every
    // assertion below pass no matter what the config said.
    expect(labelsIn(read(".github", "dependabot.yml"))).toContain("dependencies");
  });

  it("parses the labels out of an issue template", () => {
    expect(labelsIn(read(".github", "ISSUE_TEMPLATE", "bug_report.yml"))).toContain("bug");
  });

  it("only asks Dependabot for labels the repository has", () => {
    for (const label of labelsIn(read(".github", "dependabot.yml"))) {
      expect(
        REPO_LABELS.has(label),
        `dependabot.yml names a label that does not exist: ${label}`,
      ).toBe(true);
    }
  });

  it("only asks the issue templates for labels the repository has", () => {
    for (const template of issueTemplates) {
      for (const label of labelsIn(read(".github", "ISSUE_TEMPLATE", template))) {
        expect(
          REPO_LABELS.has(label),
          `${template} names a label that does not exist: ${label}`,
        ).toBe(true);
      }
    }
  });
});
