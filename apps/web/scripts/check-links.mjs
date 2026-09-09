#!/usr/bin/env node
/**
 * Verify every hardcoded internal link resolves to a real route.
 *
 * A typo'd `href` is the quietest bug this app can ship. It type-checks (it's a
 * string), it lints, it renders, and the page it sits on looks perfect. Nothing
 * goes wrong until a user clicks it and lands on the 404 — which, on the
 * teacher dashboard or the public booking funnel, is a dead end in the middle of
 * a paid flow. `next build` does not catch it: Next has no idea whether a given
 * string was meant to be a route.
 *
 * This is the App Router equivalent of a static-site link checker. It derives
 * the real route table from the filesystem (the same way Next does), collects
 * every literal internal href in the source, and reports the ones nothing can
 * serve.
 *
 * Deliberately conservative — it only looks at STRING LITERALS:
 *
 *     <Link href="/dashboard/clases">      ← checked
 *     <Link href={`/students/${id}`}>      ← ignored (template literal)
 *     <Link href={route}>                  ← ignored (variable)
 *
 * A dynamic href can't be validated without evaluating the expression, and
 * guessing produces false positives. False positives are the thing that gets a
 * check like this switched off, so the rule is: prove it's broken, or say
 * nothing. That still covers the whole nav/sidebar/footer/CTA surface, which is
 * where hand-written paths actually live.
 *
 *   node scripts/check-links.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "..");
const appDir = join(webRoot, "src", "app");
const srcDir = join(webRoot, "src");
const publicDir = join(webRoot, "public");

/**
 * Paths served by something other than a file in src/app.
 *
 * Keep this list short and justified — every entry is a hole in the check.
 */
const ALLOWED_PREFIXES = [
  // Rewritten to PostHog's ingestion hosts in next.config.ts.
  "/ingest",
  // The Sentry tunnel route (next.config.ts `tunnelRoute`), created by the
  // Sentry webpack/turbopack plugin rather than by a file in src/app.
  "/monitoring",
  // Well-known endpoints are served from src/app/.well-known via route
  // handlers whose directory name starts with a dot.
  "/.well-known",
];

/* ------------------------------------------------------------------ *
 * Route table — derived from the filesystem, the way Next does it
 * ------------------------------------------------------------------ */

/**
 * Is this directory name a real URL segment?
 *
 * Next.js has several folder conventions that exist in the tree but contribute
 * nothing to the URL, and one that removes the folder from routing entirely.
 */
function segmentKind(name) {
  if (name.startsWith("_")) return "private"; // _components — not routed at all
  if (name.startsWith("(") && name.endsWith(")")) return "transparent"; // (app) route group
  if (name.startsWith("@")) return "transparent"; // @modal parallel route slot
  return "segment";
}

/** Convert one URL segment from filesystem form to a regex fragment. */
function segmentToRegex(name) {
  // [[...slug]] — optional catch-all: matches zero or more segments.
  if (name.startsWith("[[...") && name.endsWith("]]")) return "(?:/.*)?";
  // [...slug] — catch-all: matches one or more segments.
  if (name.startsWith("[...") && name.endsWith("]")) return "/.+";
  // [slug] — exactly one segment.
  if (name.startsWith("[") && name.endsWith("]")) return "/[^/]+";
  return `/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
}

/**
 * Walk src/app and collect a regex per routable path.
 *
 * Both page.tsx (rendered pages) and route.ts (API/handlers) count — a link to
 * /api/account/export is as real as a link to /dashboard.
 */
function collectRoutes(dir = appDir, segments = []) {
  const routes = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      const kind = segmentKind(entry);
      if (kind === "private") continue;
      routes.push(...collectRoutes(full, kind === "transparent" ? segments : [...segments, entry]));
      continue;
    }

    if (!/^(page|route)\.(t|j)sx?$/.test(entry)) continue;

    const pattern = segments.map(segmentToRegex).join("") || "/";
    routes.push({
      regex: new RegExp(`^${pattern === "/" ? "/" : pattern}/?$`),
      source: relative(webRoot, full),
    });
  }

  return routes;
}

/* ------------------------------------------------------------------ *
 * Link collection
 * ------------------------------------------------------------------ */

const SOURCE_EXTENSIONS = [".tsx", ".ts"];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      yield* sourceFiles(full);
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !entry.includes(".test.")) {
      yield full;
    }
  }
}

/**
 * Pull literal internal links out of one file's source.
 *
 * Matches href="/..." and href={"/..."} — both spellings appear in this
 * codebase. Anything non-literal is skipped by construction.
 */
export function extractLinks(source) {
  const found = [];
  const pattern = /href=(?:"(\/[^"]*)"|\{\s*"(\/[^"]*)"\s*\})/g;

  let match;
  while ((match = pattern.exec(source)) !== null) {
    found.push(match[1] ?? match[2]);
  }
  return found;
}

/** Strip query string and fragment — neither affects which route serves it. */
export function normalizePath(href) {
  return href.split("#")[0].split("?")[0];
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

export function checkLinks() {
  const routes = collectRoutes();
  const broken = [];
  let checked = 0;

  for (const file of sourceFiles(srcDir)) {
    const links = extractLinks(readFileSync(file, "utf8"));

    for (const href of links) {
      const path = normalizePath(href);
      // A bare "#..." or "?..." href normalizes to empty — same page, fine.
      if (path === "") continue;
      checked += 1;

      if (ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        continue;
      }
      // Static files shipped from public/ are real URLs with no route file.
      if (existsSync(join(publicDir, path))) continue;

      if (!routes.some((route) => route.regex.test(path))) {
        broken.push({ href, file: relative(webRoot, file) });
      }
    }
  }

  return { routes, broken, checked };
}

if (import.meta.filename === process.argv[1]) {
  const { routes, broken, checked } = checkLinks();

  console.log(`check-links: ${checked} literal internal link(s) against ${routes.length} routes.`);

  if (broken.length > 0) {
    console.error(`\n${broken.length} link(s) resolve to nothing:\n`);
    for (const { href, file } of broken) {
      console.error(`::error file=apps/web/${file}::${href} — no route serves this path`);
    }
    process.exit(1);
  }

  console.log("All internal links resolve.");
}
