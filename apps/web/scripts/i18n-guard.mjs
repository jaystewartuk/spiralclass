// i18n guardrail scanner — "stop the bleeding" on hardcoded user-facing copy.
//
// Web copy is mid-migration off three legacy inline patterns onto the shared
// key-based catalog (packages/shared/src/i18n). Until every surface is
// converted we can't hard-ban raw strings, so this scanner powers a RATCHET:
// it counts user-facing string literals that bypass the catalog per file, and
// the test (tests/i18n-guard.test.ts) compares against a checked-in baseline.
// New/edited files may not ADD literals beyond their baseline; the number can
// only stay flat or shrink. Fully migrated files carry a 0 and are protected.
//
// Detection is deliberately conservative (few false positives): raw JSX text
// with a letter, and string literals in the user-facing attributes below.
// Interpolated values ({expr}) and non-letter text (punctuation, numbers) are
// ignored. It won't catch every leak, but it makes NET-NEW hardcoding fail.
//
// Regenerate the baseline after migrating a surface:
//   node scripts/i18n-guard.mjs --generate
import ts from "typescript";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const WEB_SRC = join(HERE, "..", "src");
export const BASELINE_PATH = join(HERE, "i18n-guard.baseline.json");

// Attributes whose literal string value is shown to the user.
const USER_FACING_ATTRS = new Set([
  "placeholder",
  "title",
  "alt",
  "label",
  "aria-label",
  "aria-description",
  "aria-placeholder",
]);

const HAS_LETTER = /\p{L}/u;

/** Count catalog-bypassing user-facing literals in one TSX source. */
export function scanSource(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text && HAS_LETTER.test(text)) count++;
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (USER_FACING_ATTRS.has(name)) {
        const init = node.initializer;
        const literal = ts.isStringLiteral(init)
          ? init
          : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)
            ? init.expression
            : null;
        if (literal && HAS_LETTER.test(literal.text)) count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
    } else if (
      entry.endsWith(".tsx") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".stories.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Map of repo-src-relative (posix) path → offender count, for every file with
 * at least one offender. */
export function collectCounts(srcDir = WEB_SRC) {
  const counts = {};
  for (const file of walk(srcDir)) {
    const n = scanSource(file, readFileSync(file, "utf8"));
    if (n > 0) counts[relative(srcDir, file).split(sep).join("/")] = n;
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
  console.log(`Wrote baseline: ${Object.keys(ordered).length} files, ${total} literals.`);
}
