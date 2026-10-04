// i18n guard: no user-facing copy outside the shared catalog.
//
// Every user-facing string goes through the key-based catalog
// (packages/shared/src/i18n) via getT() / useT(). This was a RATCHET while the
// web copy was migrated off its inline patterns — a per-file count that could
// only shrink, against a checked-in baseline. The baseline reached zero
// (#178 step A5), so it is a ban now: any literal it finds fails
// tests/i18n-guard.test.ts, and there is no baseline to raise.
//
// What counts as a literal (conservative — few false positives):
//   * JSX text with a letter in it;
//   * a string literal in a user-facing attribute (below);
//   * a string or template literal with a letter, inside a {…} JSX child —
//     including both arms of a ternary and the fallback of && / || / ??.
//     That last case was invisible to the ratchet, and it hid a Google
//     sign-in button that said "Continuar con Google" to every reader.
// What does not:
//   * interpolated values, and text with no letter (numbers, punctuation);
//   * text inside <code>, <kbd> or <samp>, which holds identifiers — an env
//     var's name, a webhook event type — not copy;
//   * the files in EXEMPT, each with its reason.
//
//   node scripts/i18n-guard.mjs     lists every literal, with its line
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const WEB_SRC = join(HERE, "..", "src");

/** Paths (relative to src/) that may hold literals, and why. */
export const EXEMPT = {
  "app/design/page.tsx":
    "The design system rendered from itself: a builders' reference, not indexed, " +
    "whose labels are the names of tokens and components.",
};

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

// Elements whose text is an identifier, not copy.
const IDENTIFIER_ELEMENTS = new Set(["code", "kbd", "samp"]);

const HAS_LETTER = /\p{L}/u;

function insideIdentifierElement(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p)) return IDENTIFIER_ELEMENTS.has(p.openingElement.tagName.getText());
  }
  return false;
}

/** String literals with letters an expression can render as text. */
function renderedLiterals(expr, out) {
  if (!expr) return out;
  if (ts.isParenthesizedExpression(expr)) return renderedLiterals(expr.expression, out);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    if (HAS_LETTER.test(expr.text)) out.push(expr);
  } else if (ts.isTemplateExpression(expr)) {
    const text = [expr.head.text, ...expr.templateSpans.map((s) => s.literal.text)].join("");
    if (HAS_LETTER.test(text)) out.push(expr);
  } else if (ts.isConditionalExpression(expr)) {
    renderedLiterals(expr.whenTrue, out);
    renderedLiterals(expr.whenFalse, out);
  } else if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) renderedLiterals(expr.right, out);
    else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      renderedLiterals(expr.left, out);
      renderedLiterals(expr.right, out);
    }
  }
  return out;
}

/** Every catalog-bypassing user-facing literal in one TSX source, with its
 * line and text. */
export function findLiterals(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const record = (node, text) =>
    found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text && HAS_LETTER.test(text) && !insideIdentifierElement(node)) record(node, text);
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (USER_FACING_ATTRS.has(name)) {
        const init = node.initializer;
        const literal = ts.isStringLiteral(init)
          ? init
          : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)
            ? init.expression
            : null;
        if (literal && HAS_LETTER.test(literal.text)) record(node, `${name}="${literal.text}"`);
      }
    } else if (
      ts.isJsxExpression(node) &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      !insideIdentifierElement(node)
    ) {
      for (const literal of renderedLiterals(node.expression, [])) {
        record(literal, literal.getText(sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** How many literals one TSX source holds. */
export function scanSource(fileName, source) {
  return findLiterals(fileName, source).length;
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

/** Every literal in src/, outside EXEMPT, as "path:line  text". */
export function collectViolations(srcDir = WEB_SRC) {
  const violations = [];
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file).split(sep).join("/");
    if (rel in EXEMPT) continue;
    for (const { line, text } of findLiterals(file, readFileSync(file, "utf8"))) {
      violations.push(`${rel}:${line}  ${text.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  return violations;
}

if (import.meta.filename === process.argv[1]) {
  const violations = collectViolations();
  for (const v of violations) console.log(v);
  console.log(`${violations.length} literal(s) outside the catalog.`);
  process.exit(violations.length > 0 ? 1 : 0);
}
