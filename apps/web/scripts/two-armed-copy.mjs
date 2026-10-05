// Two-armed copy scanner — counts the call sites that choose between an
// English string and a Spanish one instead of asking the catalog.
//
// The shape is `usesEnglishCopy(locale) ? english : spanish`, or the same
// question asked the other way round, `languageCode === "es" ? spanish :
// english`. Both are correct for two languages and wrong for every other one:
// a French reader gets the English arm for each of them, and the catalog's
// completeness guard cannot see a string that never became a key. Adding a
// locale does not fail the build for any of this, which is the promise the
// registry makes.
//
// tests/i18n/two-armed-copy.test.ts held the count to a baseline that could
// only shrink while the call sites moved into the catalog. It reached zero
// (#178), so it is a ban: any call site fails, and there is no baseline. The
// predicate itself, `usesEnglishCopy`, is deleted; a comparison against "es"
// is what would bring the shape back.
//
// i18n-guard.mjs cannot do this job. It counts JSX text and user-facing
// attributes, and most of these strings were neither — they were error
// messages returned from server actions and sentences assembled in email
// templates.
//
//   node scripts/two-armed-copy.mjs     lists every call site
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..");

// Both trees that hold user-facing copy. The shared package is scanned too:
// the helpers the handlers and the UI agree on live there, and a two-armed
// string in one of them is two-armed at every call site.
export const SCAN_ROOTS = ["apps/web/src", "packages/shared/src"];

// A call to the predicate, or a comparison against Spanish. Deliberately
// narrow, like the `=== "en"` guard beside it: a pattern that guessed at
// intent would need suppression comments, and a suppression is how a rule
// quietly stops applying. A comparison that is not choosing copy — a speech
// vendor's regional code — belongs in a data table keyed by language, which
// is also how the next language gets added.
const TWO_ARMED = /usesEnglishCopy\(|[!=]==\s*"es"/g;

/** Count two-armed call sites in one source, ignoring comment lines. */
export function scanSource(source) {
  let count = 0;
  for (const line of source.split("\n")) {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
    count += code.match(TWO_ARMED)?.length ?? 0;
  }
  return count;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|stories)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Map of repo-relative (posix) path → call-site count, for every file with at
 * least one. */
export function collectCounts(repoRoot = REPO_ROOT) {
  const counts = {};
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      const path = relative(repoRoot, file).split(sep).join("/");
      const n = scanSource(readFileSync(file, "utf8"));
      if (n > 0) counts[path] = n;
    }
  }
  return counts;
}

/** Every call site, as "path: count". */
export function collectViolations(repoRoot = REPO_ROOT) {
  return Object.entries(collectCounts(repoRoot)).map(([path, n]) => `${path}: ${n}`);
}

if (import.meta.filename === process.argv[1]) {
  const violations = collectViolations();
  for (const v of violations) console.log(v);
  console.log(`${violations.length} file(s) choose between an English and a Spanish string.`);
  process.exit(violations.length > 0 ? 1 : 0);
}
