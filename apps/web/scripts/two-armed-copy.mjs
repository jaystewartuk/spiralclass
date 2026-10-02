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
// tests/i18n/two-armed-copy.test.ts holds the count to a checked-in baseline,
// per file, and the count may only shrink. That is all this does: it migrates
// nothing. It exists so the number cannot grow while the migration is under
// way, and so the day it reaches zero the ratchet can become a ban.
//
// i18n-guard.mjs cannot do this job. It counts JSX text and user-facing
// attributes, and most of these strings are neither — they are error messages
// returned from server actions and sentences assembled in email templates.
//
// Regenerate the baseline after migrating a file:
//   node scripts/two-armed-copy.mjs --generate
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const BASELINE_PATH = join(HERE, "two-armed-copy.baseline.json");

// Both trees that hold user-facing copy. The shared package is scanned too:
// the helpers the handlers and the UI agree on live there, and a two-armed
// string in one of them is two-armed at every call site.
export const SCAN_ROOTS = ["apps/web/src", "packages/shared/src"];

// The one place the predicate is defined rather than used.
const DEFINITION = "packages/shared/src/i18n/locales.ts";

// A call to the predicate, or a comparison against Spanish. Deliberately
// narrow, like the `=== "en"` guard beside it: a pattern that guessed at
// intent would need suppression comments, and a suppression is how a rule
// quietly stops applying. A comparison that is not choosing copy (a teaching
// language, an ASR model) is counted too and stays in the baseline until the
// ratchet becomes a ban, when it moves to an allowlist that says why.
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
      if (path === DEFINITION) continue;
      const n = scanSource(readFileSync(file, "utf8"));
      if (n > 0) counts[path] = n;
    }
  }
  return counts;
}

export function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

if (process.argv.includes("--generate")) {
  const counts = collectCounts();
  const ordered = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(ordered, null, 2) + "\n");
  const total = Object.values(ordered).reduce((a, b) => a + b, 0);
  console.log(`Wrote baseline: ${Object.keys(ordered).length} files, ${total} call sites.`);
}
