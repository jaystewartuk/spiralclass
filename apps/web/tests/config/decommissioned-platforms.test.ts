import { readFileSync, readdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// Supabase and Vercel are fully decommissioned (D-89 Phase 5). Both are named in
// CLAUDE.md as things never to reintroduce, and today the source tree is clean:
// no @supabase/supabase-js dependency, no SUPABASE_* / NEXT_PUBLIC_SUPABASE_*
// reads, no VERCEL_ENV branch (prod-vs-preview is decided by APP_URL).
//
// That state is currently held by convention alone. A reintroduction would not
// fail any existing check — it type-checks, lints, and builds, and on a preview
// deploy where the old env vars happen to still be set it would even work,
// quietly re-coupling the app to a platform that no longer exists in production.
// The tell would be a runtime failure in prod, long after merge.
//
// So this test is the enforcement layer for that policy. It scans real code (not
// comments — the remaining textual mentions are all historical notes explaining
// the removal, and those should stay readable) for the specific shapes a
// reintroduction takes: a package dependency, an env-var read, or an import.
//
// Deliberately NOT flagged: the string "supabase" as an expense-vendor key in
// packages/shared/src/expenses-config.ts and its i18n catalog labels. Those
// describe a line item on a real invoice from the decommissioning period — data
// about the past, not a code path into it.

const SOURCE_ROOTS = ["apps/web/src", "packages/shared/src"];

const PACKAGE_JSONS = ["package.json", "apps/web/package.json", "packages/shared/package.json"];

/**
 * Build and deploy configuration, which the source scan above never reaches.
 *
 * This is the gap D-164 found: the `Dockerfile` still declared `SUPABASE_URL`,
 * `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` as build-time `ENV`,
 * feeding a Zod schema that had dropped all three when D-89 decommissioned
 * Supabase — for months, past every run of this file, because a Dockerfile is
 * not under `apps/web/src`. Placeholder credentials for a torn-down platform
 * are not load-bearing, but they are the strongest possible signal to the next
 * reader that the platform is still wired in.
 *
 * ⚠️ `turbo.json` fell through the same hole and was found the same way, on
 * 2026-09-06. Its build task named `VERCEL_ENV`, `VERCEL_GIT_COMMIT_REF` and
 * all three `SUPABASE_*` variables in its cache-key `env` list. Nothing read
 * them, so nothing broke — but a cache key is a claim about what the build
 * depends on, and this one said the build depended on two platforms that no
 * longer exist. Fixing the list without widening this guard would have left
 * the hole open, which is the whole lesson of D-164.
 */
const DEPLOY_CONFIGS = [
  "Dockerfile",
  "fly.production.toml",
  "fly.preview.toml",
  "docker-compose.yml",
  "turbo.json",
];

/**
 * Files with no comment syntax, where a BARE name is unambiguous.
 *
 * The `=`-anchored patterns below exist so a `#` comment explaining a removal
 * stays readable. Strict JSON has no comments to protect, so a bare
 * `"SUPABASE_URL"` in a list is always a live declaration and can be matched
 * as one. Keep this to genuinely comment-free formats.
 */
const NO_COMMENT_CONFIGS = new Set(["turbo.json"]);

const BARE_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\b(NEXT_PUBLIC_)?SUPABASE_[A-Z_]+\b/,
    why: "names a SUPABASE_* variable — Supabase is decommissioned (D-89 Phase 5)",
  },
  {
    pattern: /\bVERCEL_[A-Z_]+\b/,
    why: "names a VERCEL_* variable — Vercel is decommissioned (D-89 Phase 5); prod-vs-preview is decided by APP_URL",
  },
];

/** Config files that must not come back at all. */
const BANNED_FILES: ReadonlyArray<readonly [string, string]> = [
  [
    "vercel.json",
    "configures Vercel git deployments — the Vercel project was torn down in D-89 Phase 5",
  ],
  ["vercel.jsonc", "same as vercel.json — Vercel is decommissioned (D-89 Phase 5)"],
];

/** An assignment, not a mention: `#`-commented history must stay readable. */
const DEPLOY_CONFIG_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\b(NEXT_PUBLIC_)?SUPABASE_[A-Z_]+\s*=/,
    why: "sets a SUPABASE_* variable — Supabase is decommissioned (D-89 Phase 5) and no schema reads it",
  },
  {
    pattern: /\bVERCEL_(ENV|URL)\s*=/,
    why: "sets a VERCEL_* variable — Vercel is decommissioned (D-89 Phase 5); prod-vs-preview is decided by APP_URL",
  },
];

/**
 * Code shapes that re-couple the app to a decommissioned platform.
 *
 * Every pattern requires a syntactic anchor (`process.env.`, an import
 * specifier) rather than a bare name, so a comment explaining why the thing was
 * removed can't trip it. The line-level comment filter below is a second layer.
 */
const BANNED_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /process\.env\.(NEXT_PUBLIC_)?SUPABASE_[A-Z_]+/,
    why: "reads a SUPABASE_* env var — Supabase is decommissioned (D-89 Phase 5); the database is Neon and object storage is Cloudflare R2",
  },
  {
    pattern: /process\.env\.VERCEL_(ENV|URL)\b/,
    why: "branches on a VERCEL_* env var — Vercel is decommissioned (D-89 Phase 5); prod-vs-preview is decided by APP_URL",
  },
  {
    pattern: /from\s+["']@supabase\/|require\(\s*["']@supabase\//,
    why: "imports the Supabase SDK — Supabase is decommissioned (D-89 Phase 5)",
  },
];

const BANNED_DEPENDENCIES = [/^@supabase\//, /^@vercel\/(?!analytics$)/];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      yield* sourceFiles(full);
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      yield full;
    }
  }
}

/**
 * Drop whole-line comments before matching.
 *
 * Line-level rather than a real comment stripper on purpose: stripping `//`
 * inside a string literal would mangle every URL in the file ("https://..."),
 * and the cost of a mangled line here is a false PASS. Combined with the
 * `process.env.` / import anchors above, whole-line filtering is enough.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

describe("decommissioned platforms stay decommissioned", () => {
  const violations: string[] = [];

  for (const root of SOURCE_ROOTS) {
    const absolute = resolve(REPO_ROOT, root);
    if (!existsSync(absolute)) continue;

    for (const file of sourceFiles(absolute)) {
      const lines = readFileSync(file, "utf8").split("\n");

      lines.forEach((line, index) => {
        if (isCommentLine(line)) return;

        for (const { pattern, why } of BANNED_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${relative(REPO_ROOT, file)}:${index + 1} ${why}\n    ${line.trim()}`);
          }
        }
      });
    }
  }

  it("no source file reads Supabase/Vercel env vars or imports their SDKs", () => {
    expect(
      violations,
      violations.length
        ? `Decommissioned-platform code reintroduced:\n\n${violations.join("\n\n")}\n`
        : "",
    ).toEqual([]);
  });

  it.each(PACKAGE_JSONS)("%s declares no decommissioned-platform dependency", (relPath) => {
    const absolute = resolve(REPO_ROOT, relPath);
    if (!existsSync(absolute)) return;

    const pkg = JSON.parse(readFileSync(absolute, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];

    const banned = declared.filter((name) => BANNED_DEPENDENCIES.some((re) => re.test(name)));

    expect(
      banned,
      `${relPath} depends on ${banned.join(", ")} — Supabase and Vercel are decommissioned ` +
        `(D-89 Phase 5). Do not reintroduce the dependency.`,
    ).toEqual([]);
  });

  it.each(DEPLOY_CONFIGS)("%s sets no decommissioned-platform variable", (relPath) => {
    const absolute = resolve(REPO_ROOT, relPath);
    if (!existsSync(absolute)) return;

    const patterns = NO_COMMENT_CONFIGS.has(relPath)
      ? [...DEPLOY_CONFIG_PATTERNS, ...BARE_NAME_PATTERNS]
      : DEPLOY_CONFIG_PATTERNS;

    const offences: string[] = [];
    readFileSync(absolute, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (line.trimStart().startsWith("#")) return;
        for (const { pattern, why } of patterns) {
          if (pattern.test(line))
            offences.push(`${relPath}:${index + 1} ${why}\n    ${line.trim()}`);
        }
      });

    expect(
      offences,
      offences.length ? `Decommissioned-platform config:\n\n${offences.join("\n\n")}\n` : "",
    ).toEqual([]);
  });

  it.each(BANNED_FILES)("%s does not exist", (relPath, why) => {
    expect(
      existsSync(resolve(REPO_ROOT, relPath)),
      `${relPath} is back. It ${why}. Delete it.`,
    ).toBe(false);
  });
});
