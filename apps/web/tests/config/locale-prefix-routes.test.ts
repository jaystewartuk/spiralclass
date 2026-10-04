import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES, LOCALIZED_PUBLIC_PATHS } from "@spiralclass/shared";

// D-193 rests on two facts about app/, and nothing else checks either.
//
// 1. A prefixed URL that is not a public page — `/es/dashboard` — is passed
//    through by the middleware untouched, and is a 404 only because no route
//    answers it. A top-level dynamic segment (`app/[slug]`, or one inside a
//    route group) would answer it, and a locale prefix could then reach a
//    page it was never meant to.
// 2. A folder named like a locale prefix (`app/es`) would collide with the
//    rewrite.
//
// And the localized pages must exist, or the allowlist names a 404.

const APP_DIR = join(__dirname, "..", "..", "src", "app");

/** The first URL segment of every route: folders at the top of app/, with
 * route groups `(name)` looked through, since they add no segment. */
function topLevelSegments(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (name.startsWith("(") && name.endsWith(")")) out.push(...topLevelSegments(full));
    else out.push(name);
  }
  return out;
}

describe("app/ cannot answer a locale-prefixed private path", () => {
  const segments = topLevelSegments(APP_DIR);

  it("has no dynamic segment at the top of the URL", () => {
    expect(segments.filter((s) => s.startsWith("["))).toEqual([]);
  });

  it("has no folder named like a locale prefix", () => {
    const prefixes = LOCALES.map((l) => l.tag.toLowerCase());
    expect(segments.filter((s) => prefixes.includes(s))).toEqual([]);
  });

  it("has a route for every localized public page", () => {
    for (const path of LOCALIZED_PUBLIC_PATHS) {
      if (path === "/") continue;
      expect(segments, path).toContain(path.slice(1));
    }
  });
});
