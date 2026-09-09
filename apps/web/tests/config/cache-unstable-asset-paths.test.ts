import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Nothing hand-written may point at a Next file-convention asset route.
 *
 * WHY. `app/icon.svg`, `app/apple-icon.tsx` and `app/opengraph-image.tsx`
 * compile to routes whose bytes change with the design while the URL never
 * does, and Next serves them `public, immutable, no-transform,
 * max-age=31536000` — the static-asset branch of
 * next-metadata-route-loader for `icon.svg`, and `ImageResponse`'s own header
 * for the two dynamic ones.
 *
 * That is safe in exactly one place: the `<head>` references Next renders
 * ITSELF, because next-metadata-image-loader appends a `?<contenthash>` query
 * to each one. Every hand-written reference misses that hash, so a CDN pins it
 * to whatever it cached first — permanently, as far as any user is concerned.
 *
 * It shipped three times, and each was found by a person looking at a screen
 * rather than by a check:
 *
 *   - `manifest.ts` served an installed app the previous brand's icon while
 *     the origin served the current one. Verified live at the edge.
 *   - `public/sw.js` put that same stale monogram on every push notification,
 *     for months, next to a correct app icon.
 *   - `lib/seo/jsonld.ts` handed the same path to Google as the Organization
 *     logo.
 *
 * The fix in all three was the same: reference `public/brand/*` instead, whose
 * files are written by scripts/brand-assets.mjs and therefore change bytes in
 * the same commit as the design. So the rule is checked, not commented — the
 * second and third instances were both written after the first one's comment
 * explained the problem.
 */

/** The routes. Matched as a whole quoted or interpolated path, so a mention in
 * prose (this file, the comments the fixes left behind) does not trip it. */
const UNSTABLE = ["/icon.svg", "/apple-icon", "/opengraph-image", "/twitter-image"];

/** Where a hand-written reference can reach a user. `public/` is included
 * because that is where the service worker lives. */
const ROOTS = ["src", "public"].map((d) => join(__dirname, "..", "..", d));

/**
 * Files that legitimately name one.
 *
 * Kept deliberately short. A file earns a place here by DEFINING the route or
 * by being the test for it — never by referencing it, which is the thing this
 * guard exists to prevent.
 */
const ALLOWED = [
  "app/apple-icon.tsx", // defines the route
  "app/opengraph-image.tsx", // defines the route
  "b/[slug]/opengraph-image.tsx", // defines the per-teacher route
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!["node_modules", ".next", "coverage"].includes(entry)) walk(full, out);
    } else if (/\.(tsx?|js|mjs|json|webmanifest)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => f.split("/apps/web/")[1] ?? f;

describe("cache-unstable asset paths", () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it("finds files to check", () => {
    // Guards the guard — a walk returning nothing would pass silently, which
    // is how the first two instances survived a repo that already had a
    // comment about them.
    expect(files.length).toBeGreaterThan(300);
  });

  it("appear in no hand-written reference", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED.some((a) => file.includes(a))) continue;
      // Comment lines are stripped first, and deliberately: each of the three
      // fixes left behind a comment NAMING the path it must not use, and a
      // guard that cannot tell a reference from its own prohibition is one
      // people delete. What must not survive is a live string.
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      for (const route of UNSTABLE) {
        // The path inside a string or a template literal, ending there or
        // continuing into a query — not a longer path that merely starts with
        // it (`/icon.svg.bak`).
        //
        // `}` leads the character class as well as the quotes, and that is not
        // cosmetic: the jsonld instance was `${baseUrl}/icon.svg`, so a guard
        // anchored on quotes alone reports the file clean. Verified by putting
        // that exact line back and watching this fail.
        const pattern = new RegExp(`["'\`}]${route.replace(".", "\\.")}(?=["'?\`])`);
        if (pattern.test(code)) offenders.push(`${rel(file)}: ${route}`);
      }
    }
    expect(
      offenders,
      `These reference a Next file-convention route, which is served immutable ` +
        `at a path that never changes. Only the <head> references Next renders ` +
        `itself carry the content hash that makes that safe. Point at the ` +
        `generated equivalent under public/brand instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
