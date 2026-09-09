// Design-system drift scanner — the measuring instrument for the design
// re-architecture (D-139).
//
// The token DEFINITION layer in this repo is disciplined: one hex source
// (packages/shared/src/tokens.ts), an HSL mirror in globals.css guarded by
// src/lib/theme-parity.test.ts, and a breakpoint module guarded by
// tests/config/responsive-breakpoints.test.ts. The drift is entirely in the
// CONSUMPTION layer — components that bypass the tokens they were given.
//
// This scanner counts those bypasses per file, in seven categories, and
// tests/design-drift.test.ts compares the result against a checked-in
// baseline. It is a RATCHET, in the same shape as scripts/i18n-guard.mjs:
// a file may not add bypasses beyond its baseline, and a file that has been
// migrated to zero is protected from regressing.
//
// Why a ratchet and not a hard ban: ~400 bypasses exist today across 440
// files. Banning them outright would mean one un-reviewable commit. The
// ratchet lets the migration land surface by surface while making NET-NEW
// drift fail immediately — which is the property that actually matters, since
// the failure mode being prevented is "it all comes back in a month".
//
// The eslint rule (eslint-rules/design-tokens.mjs) is the developer-facing
// half of the same policy: it explains the fix at the point of writing. This
// scanner is the accounting half — it produces the number that goes in the
// before/after.
//
// Regenerate the baseline after migrating a surface:
//   node scripts/design-drift.mjs --generate
//
// Print a human-readable report with totals and worst offenders:
//   node scripts/design-drift.mjs --report
import ts from "typescript";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const WEB_SRC = join(HERE, "..", "src");
export const BASELINE_PATH = join(HERE, "design-drift.baseline.json");

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Each category names one way a component can bypass the token layer, and
 * carries the fix in `remedy` so the eslint rule and the test can both quote
 * it rather than restating it.
 */
export const CATEGORIES = {
  rawHex: {
    label: "raw hex colours",
    remedy: "use a semantic token — hsl(var(--…)) in CSS, palette.* from packages/shared in TS",
  },
  rawColorFn: {
    label: "literal rgb()/rgba()/hsl() colours",
    remedy: "use hsl(var(--token)); a literal channel triple is invisible to the parity test",
  },
  rawPalette: {
    label: "raw Tailwind palette utilities",
    remedy:
      "use a semantic utility (bg-muted, text-muted-foreground) or a Badge/Alert variant — " +
      "raw palette shades have no dark: counterpart and render light-on-light in dark mode",
  },
  arbitraryValue: {
    label: "arbitrary Tailwind values",
    remedy: "use a scale step; if none fits, the scale is wrong — add it to tailwind.config.ts",
  },
  rawButton: {
    label: "raw <button> elements",
    remedy: "use <Button> from @/components/ui/button so focus, disabled and sizing are shared",
  },
  scrimOpacity: {
    label: "ad-hoc white/black scrim opacities",
    remedy: "use an overlay token — bg-overlay-1..4 — rather than inventing an opacity",
  },
  inlineStyle: {
    label: "inline style objects with literal values",
    remedy: "use utilities; inline literals escape both the token layer and the parity test",
  },
};

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Files exempt from specific categories, each with the reason. An entry here
 * is a claim that the bypass is correct, not that it is tolerated — anything
 * merely tolerated belongs in the baseline, where the ratchet keeps pressure
 * on it.
 *
 * Paths are src-relative posix. A category maps to `true` for a whole-file
 * exemption.
 */
export const ALLOWLIST = {
  // Satori renders these to PNG with its own CSS subset. It does not run
  // Tailwind at all, so utilities are unavailable and inline style objects
  // are the only way to express anything. They consume palette.* directly,
  // which is the correct source; the literals they still hold are counted.
  "app/opengraph-image.tsx": { inlineStyle: true },
  "app/apple-icon.tsx": { inlineStyle: true },
  "app/b/[slug]/opengraph-image.tsx": { inlineStyle: true },
  "app/api/og/social-preview/[id]/route.tsx": { inlineStyle: true },

  // Google's sign-in mark is specified by Google's brand guidelines and may
  // not be recoloured to fit ours. The four hexes are the official values.
  "app/(auth)/google-sign-in-button.tsx": { rawHex: true },

  // Recharts takes colours through props, not className. The wrapper exists
  // precisely so that every chart reads --chart-1..4 from one place.
  "components/ui/chart-impl.tsx": { inlineStyle: true },

  // Calendar event positioning is computed from time arithmetic — a top/height
  // percentage cannot be a utility class.
  "components/calendar/time-grid.tsx": { inlineStyle: true },
};

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

// A hex colour: 3, 6 or 8 digits, all hex, delimited. A path fragment
// ("/docs#section") is excluded by the leading boundary. A bare anchor
// ("#123") is genuinely indistinguishable from a 3-digit colour by shape
// alone, so link targets are stripped before this runs — see HEX_PREPROCESS.
const HEX = /(?<![\w/])#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

// Remove href/src/action targets so an anchor is never read as a colour.
const HEX_PREPROCESS = (text) =>
  text.replace(/\b(?:href|src|action|to)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g, "");

// rgb()/rgba()/hsl()/hsla() with a literal first channel. `hsl(var(--x))` is
// the correct pattern and must not match.
const COLOR_FN = /\b(?:rgba?|hsla?)\(\s*[\d.]/g;

// Tailwind's stock palette families. The semantic families this design system
// defines (primary, muted, accent, clay, sage, …) are deliberately absent —
// those are the tokens, and using them is the point.
const STOCK_FAMILIES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
// bg-amber-100, text-emerald-900, border-sky-200/50, hover:bg-red-600, dark:text-violet-400
const RAW_PALETTE = new RegExp(
  String.raw`(?:^|[\s"'\`])(?:[a-z-]+:)*(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|shadow|accent|caret|decoration|placeholder)-(?:${STOCK_FAMILIES})-\d{2,3}\b`,
  "g",
);

// Arbitrary values: text-[11px], min-w-[16rem], z-[60]. Radix/ARIA state
// variants (data-[state=open]:, supports-[…], group-[…], aria-[…], peer-[…])
// are a different language feature that happens to share the bracket syntax —
// they are not values and are excluded.
// `-[var(--…)]` reads a custom property, which is token usage rather than a
// bypass — Radix publishes several and consuming them is correct. Excluded here
// so the scanner and eslint-rules/design-tokens.mjs agree.
const ARBITRARY =
  /(?:^|[\s"'`])(?:[a-z-]+:)*(?!data-|supports-|group-|peer-|aria-|has-)[a-z][\w-]*-\[(?!var\(--)[^\]]+\]/g;

// A raw <button> tag. <Button> (capital B) is the primitive and must not match.
const RAW_BUTTON = /<button[\s>]/g;

// bg-white/15, text-black/60, border-white/20 — an opacity invented at the
// call site rather than drawn from a scale.
const SCRIM =
  /(?:^|[\s"'`])(?:[a-z-]+:)*(?:bg|text|border|from|via|to|ring|divide)-(?:white|black)\/\d{1,3}\b/g;

// style={{ … }} containing at least one literal string or number value.
// style={someVariable} is computed and out of scope.
const INLINE_STYLE = /style=\{\{[^}]*(?::\s*(?:"|'|`|\d))[^}]*\}\}/g;

const DETECTORS = {
  rawHex: HEX,
  rawColorFn: COLOR_FN,
  rawPalette: RAW_PALETTE,
  arbitraryValue: ARBITRARY,
  rawButton: RAW_BUTTON,
  scrimOpacity: SCRIM,
  inlineStyle: INLINE_STYLE,
};

/**
 * Blank out comments so a commented-out example is not counted, using the
 * TypeScript scanner rather than regexes.
 *
 * The regex version was wrong in the direction that matters: it ate 64% of
 * `settings/account/page.tsx` — including the `border-green-200 bg-green-50`
 * banner it was supposed to find — because a `/*` inside a JSX string ran to a
 * `*\/` thousands of characters later. Files disappeared from the baseline
 * entirely, so the ratchet was guarding nothing on exactly the surfaces that
 * had the most drift.
 *
 * Comment text is replaced with spaces rather than removed, so every remaining
 * offset stays where it was and no two tokens are accidentally joined.
 */
function stripComments(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.JSX,
    source,
  );
  const out = source.split("");
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      for (let i = scanner.getTokenStart(); i < scanner.getTokenEnd(); i++) {
        if (out[i] !== "\n") out[i] = " ";
      }
    }
    token = scanner.scan();
  }
  return out.join("");
}

/**
 * Count token bypasses in one source file, by category.
 *
 * @param {string} relPath src-relative posix path, used for the allowlist
 * @param {string} source
 * @returns {Record<string, number>} categories with a non-zero count
 */
export function scanSource(relPath, source) {
  const text = stripComments(source);
  const exempt = ALLOWLIST[relPath] ?? {};
  const counts = {};
  for (const [category, pattern] of Object.entries(DETECTORS)) {
    if (exempt[category] === true) continue;
    // `content-['']` sets generated content, not a design value — and the
    // .table-stack responsive system depends on it. Excluded from the arbitrary
    // count so the scanner and the eslint rule agree.
    const subject =
      category === "rawHex"
        ? HEX_PREPROCESS(text)
        : category === "arbitraryValue"
          ? text.replace(/(?:[a-z-]+:)*(?:content|transition)-\[[^\]]*\]/g, "")
          : text;
    pattern.lastIndex = 0;
    const n = (subject.match(pattern) ?? []).length;
    if (n > 0) counts[category] = n;
  }
  return counts;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
    } else if (
      (entry.endsWith(".tsx") || entry.endsWith(".ts")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Map of src-relative posix path → { category: count } for every file with
 * at least one bypass. */
export function collectCounts(srcDir = WEB_SRC) {
  const counts = {};
  for (const file of walk(srcDir)) {
    const relPath = relative(srcDir, file).split(sep).join("/");
    const found = scanSource(relPath, readFileSync(file, "utf8"));
    if (Object.keys(found).length > 0) counts[relPath] = found;
  }
  return counts;
}

export function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

/** Totals per category across every file. */
export function totals(counts) {
  const out = Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, 0]));
  for (const perFile of Object.values(counts)) {
    for (const [category, n] of Object.entries(perFile)) out[category] += n;
  }
  return out;
}

function ordered(counts) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, cats]) => [
        file,
        Object.fromEntries(Object.entries(cats).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
}

if (process.argv.includes("--generate")) {
  const counts = ordered(collectCounts());
  writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + "\n");
  const t = totals(counts);
  const sum = Object.values(t).reduce((a, b) => a + b, 0);
  console.log(`Wrote baseline: ${Object.keys(counts).length} files, ${sum} bypasses.`);
}

if (process.argv.includes("--report")) {
  const counts = collectCounts();
  const t = totals(counts);
  const sum = Object.values(t).reduce((a, b) => a + b, 0);

  console.log(`\nDesign-system drift — ${Object.keys(counts).length} files, ${sum} bypasses\n`);
  const width = Math.max(...Object.values(CATEGORIES).map((c) => c.label.length));
  for (const [key, meta] of Object.entries(CATEGORIES)) {
    console.log(`  ${meta.label.padEnd(width)}  ${String(t[key]).padStart(5)}`);
  }

  for (const [key, meta] of Object.entries(CATEGORIES)) {
    const worst = Object.entries(counts)
      .filter(([, cats]) => cats[key])
      .sort(([, a], [, b]) => b[key] - a[key])
      .slice(0, 8);
    if (worst.length === 0) continue;
    console.log(`\n  ${meta.label} — worst offenders`);
    console.log(`    ${meta.remedy}`);
    for (const [file, cats] of worst)
      console.log(`      ${String(cats[key]).padStart(4)}  ${file}`);
  }
  console.log();
}
