import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * `bg-primary/10` may not carry `text-primary` TEXT.
 *
 * The pairing composites `primary` at 10% against whatever surface it lands on
 * and then writes on it in `primary`. Neither half is a token, so
 * src/lib/palette-contrast.test.ts cannot assert the result and axe finds it
 * instead — which is how it has been found three times:
 *
 *   - the default Badge, measured at 3.09:1 in dark mode;
 *   - the teacher/student monogram in components/teacher-identity.tsx, washed
 *     out on the dark card at 80px;
 *   - the founder monogram on /about, 4.24:1 against 4.5, which is one of the
 *     two things that turned the Heavy tier red on `main`.
 *
 * Each was fixed on its own and none of them left behind anything that would
 * notice the fourth. Two more were still live when the third was found —
 * account-avatar.tsx and recipient-picker.tsx — on authenticated surfaces the
 * a11y sweep does not audit, so nothing was ever going to report them. This is
 * the missing check: cheap, in the FAST tier, and pointed at the whole tree
 * rather than at the file being fixed that day.
 *
 * ON A TINT WITH NO TEXT IN IT the pairing is fine — WCAG 1.4.11 asks 3:1 of a
 * non-text graphic and this measures 4.24 on the darkest ground in the system.
 * So icon containers are allowed by name below, which is also what keeps this
 * test honest: an entry is a claim that the element holds an icon and no
 * words, checkable by opening the file.
 *
 * ⚠️ IT READS THE AST, NOT THE TEXT, and that is not an optimisation. Three of
 * the files that got this right carry a comment explaining the pairing they
 * avoided, in backticks, and a grep flagged all three — including this rule's
 * own remedy text. A guard that cannot tell an instruction from its own
 * prohibition is one people delete; local-gate.test.ts learned the same thing
 * about heavy.yml.
 */

const SRC = resolve(__dirname, "../src");

/**
 * Elements that carry the tint with an ICON inside and no text.
 * Each is a claim about the element's children, verifiable by reading the line.
 */
const ICON_ONLY = new Set([
  // A rounded square holding a lucide icon, above a heading and body copy that
  // carry their own colours.
  "app/about/page.tsx",
  "app/help/page.tsx",
  "components/marketing/feature-card.tsx",
]);

/** `text-primary` but not `text-primary-foreground`. */
const TEXT_PRIMARY = /\btext-primary(?![\w-])/;

const carriesThePairing = (value: string) =>
  value.includes("bg-primary/10") && TEXT_PRIMARY.test(value);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every string the file actually EVALUATES — quoted literals and the fixed
 * parts of a template — with the 1-based line each starts on. Comments are not
 * nodes, so they are absent by construction rather than by stripping.
 */
function stringLiterals(file: string): Array<{ value: string; line: number }> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Array<{ value: string; line: number }> = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push({
        value: node.text,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the primary tint never carries primary text", () => {
  const offendersByFile = new Map<string, number[]>();
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).split(sep).join("/");
    const lines = stringLiterals(file)
      .filter(({ value }) => carriesThePairing(value))
      .map(({ line }) => line);
    if (lines.length > 0) offendersByFile.set(rel, lines);
  }

  it("has no unlisted `bg-primary/10` + `text-primary` pairing", () => {
    // One literal at a time, so a className split across two cn() arguments
    // would slip past. Every call site in the tree writes the pair in one
    // string; the remedy for a clever one is to widen this, not to accept it.
    const offenders = [...offendersByFile]
      .filter(([rel]) => !ICON_ONLY.has(rel))
      .flatMap(([rel, lines]) => lines.map((line) => `${rel}:${line}`));

    expect(
      offenders,
      `\`bg-primary/10\` written on in \`text-primary\` composites to a colour no ` +
        `token names, and it fails AA as text — 4.24:1 on the dark card, which is what ` +
        `axe reported for /about. Use the neutral the other monograms use ` +
        `(bg-secondary + secondary-foreground, see components/teacher-identity.tsx) or a ` +
        `solid fill (bg-primary + primary-foreground, see components/ui/badge.tsx). If the ` +
        `element holds an icon and no text, add it to ICON_ONLY here and say ` +
        `so:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps ICON_ONLY from outliving the call sites it excuses", () => {
    // The entries are exemptions, not history. A file that stops using the tint
    // should leave this list in the same change — the mistake CLAUDE.md names
    // about the mobile route tree, which stayed alive a month past its client
    // because its guard's premise had died without the guard noticing.
    const stale = [...ICON_ONLY].filter((rel) => !offendersByFile.has(rel));
    expect(
      stale,
      `These files no longer pair the tint with \`text-primary\`, so their ICON_ONLY ` +
        `entries excuse nothing and should be deleted:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});
