import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Next.js throws an unhandled rejection at cold-start when any parent
// directory in src/app contains two or more sibling directories that are
// dynamic segments with DIFFERENT names (e.g. [id] and [studentId]).
// The error ("You cannot use different slug names for the same dynamic path")
// crashes the router before any handler runs, so every request — including
// /api/auth/callback — 504s with no useful error for the caller.
//
// This happened in #326 when the English rename moved most of a
// teacher/students/[id]/* tree to [studentId]/* but left the messages
// sub-routes under the old [id] directory. (Those particular routes lived
// under api/mobile and are gone; the failure mode is not.)
//
// This test walks the entire src/app tree and fails immediately if any such
// conflict exists, so a rename can never silently introduce this class of
// startup crash.

const APP_DIR = join(process.cwd(), "src/app");

function isDynamicSegment(name: string): boolean {
  // Matches [slug], [...slug], [[...slug]] — the three dynamic forms.
  // Excludes route groups (folder) and parallel/intercepting @folder / (...)folder.
  return name.startsWith("[") && name.endsWith("]");
}

function findSlugConflicts(): Array<{ parent: string; slugs: string[] }> {
  const conflicts: Array<{ parent: string; slugs: string[] }> = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });

    const dynamicChildren = entries
      .filter((e) => e.isDirectory() && isDynamicSegment(e.name))
      .map((e) => e.name);

    const uniqueNames = new Set(dynamicChildren);
    if (uniqueNames.size > 1) {
      conflicts.push({
        parent: relative(APP_DIR, dir),
        slugs: [...uniqueNames].sort(),
      });
    }

    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };

  walk(APP_DIR);
  return conflicts;
}

describe("Next.js app router — dynamic segment name consistency", () => {
  it("has no sibling directories with conflicting dynamic segment names", () => {
    const conflicts = findSlugConflicts();
    const detail = conflicts
      .map(
        (c) =>
          `  ${c.parent || "(app root)"}: ${c.slugs.join(" vs ")} — siblings must share one segment name`,
      )
      .join("\n");
    expect(conflicts, `Conflicting dynamic segment names found:\n${detail}`).toEqual([]);
  });
});
