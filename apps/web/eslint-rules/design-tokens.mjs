// Local ESLint rule: forbid styling that bypasses the design tokens.
//
// The developer-facing half of a policy whose accounting half is
// scripts/design-drift.mjs. The ratchet test counts bypasses and stops them
// growing; this one explains the fix at the moment someone types it, which is
// the only time the explanation is cheap.
//
// Scoped in eslint.config.mjs to the directories already migrated, so it is an
// edit-time backstop against regression rather than a wall of errors on the
// surfaces still being converted. The ratchet guards everything else.
//
// Deliberately NOT flagged here: raw <button>. Most of the remaining ones are
// drag handles, inline chips and fixed-dark video controls where <Button>
// would change what the element is, and none of them removes its focus ring.
// A lint rule that fires on all of them would train people to disable it.

const STOCK_FAMILIES = new Set([
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);

const UTILITY_PREFIXES =
  "bg|text|border|ring|from|via|to|fill|stroke|divide|outline|shadow|accent|caret|decoration|placeholder";

const RAW_PALETTE = new RegExp(`^(?:[a-z-]+:)*(?:${UTILITY_PREFIXES})-([a-z]+)-\\d{2,3}$`);
const SCRIM = new RegExp(`^(?:[a-z-]+:)*(?:${UTILITY_PREFIXES})-(?:white|black)\\/\\d{1,3}$`);
// data-[state=…] and friends share the bracket syntax but are variants, not values.
const ARBITRARY =
  /^(?:(?!data-|supports-|group-|peer-|aria-|has-)[a-z-]+:)*[a-z][\w-]*-\[[^\]]+\]$/;
// `h-[var(--radix-select-trigger-height)]` is CONSUMING a token, not bypassing
// one — the opposite of what this rule is for. Radix publishes several such
// properties and reading them is the correct way to size against a trigger.
const READS_CUSTOM_PROPERTY = /-\[var\(--[^)]+\)\]$/;
// `content-['']` sets generated content, not a size or a colour. It has no
// token to bypass, and the .table-stack responsive system depends on it.
const NOT_A_DESIGN_VALUE = /^(?:[a-z-]+:)*(?:content|transition)-\[/;
const HEX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow styling that bypasses the design tokens." },
    messages: {
      rawPalette:
        "`{{cls}}` is a raw Tailwind palette utility. It has no dark: counterpart, so it " +
        "renders light-on-light in dark mode. Use a semantic utility (bg-muted, " +
        "text-muted-foreground) or a Badge/Alert variant.",
      scrim:
        "`{{cls}}` invents an opacity. Use an overlay token — bg-overlay-1..4, bg-scrim-1..3, " +
        "text-on-dark — so the stage has one ramp instead of twenty values.",
      arbitrary:
        "`{{cls}}` is an arbitrary value. Use a scale step; if none fits, the scale is wrong — " +
        "add a named one to tailwind.config.ts.",
      hex: "Hardcoded colour `{{value}}`. Use a semantic token: hsl(var(--…)) in CSS, palette.* in TS.",
    },
    schema: [],
  },
  create(context) {
    /** Report each offending class in a className string. */
    function checkClassString(node, value) {
      for (const cls of value.split(/\s+/)) {
        if (!cls) continue;
        const palette = RAW_PALETTE.exec(cls);
        if (palette && STOCK_FAMILIES.has(palette[1])) {
          context.report({ node, messageId: "rawPalette", data: { cls } });
        } else if (SCRIM.test(cls)) {
          context.report({ node, messageId: "scrim", data: { cls } });
        } else if (
          ARBITRARY.test(cls) &&
          !READS_CUSTOM_PROPERTY.test(cls) &&
          !NOT_A_DESIGN_VALUE.test(cls)
        ) {
          context.report({ node, messageId: "arbitrary", data: { cls } });
        }
      }
    }

    return {
      JSXAttribute(node) {
        const name = node.name?.name;
        if (name !== "className" && name !== "class") return;
        const init = node.value;
        if (init?.type === "Literal" && typeof init.value === "string") {
          checkClassString(init, init.value);
        } else if (init?.type === "JSXExpressionContainer") {
          // Covers cn("…", cond && "…") and plain template literals.
          for (const lit of collectStrings(init.expression)) {
            checkClassString(lit.node, lit.value);
          }
        }
      },
      Literal(node) {
        if (typeof node.value === "string" && HEX.test(node.value)) {
          // Anchors and route fragments are not colours.
          const parent = node.parent;
          const attr = parent?.type === "JSXAttribute" ? parent.name?.name : null;
          if (attr === "href" || attr === "src" || attr === "to" || attr === "action") return;
          context.report({ node, messageId: "hex", data: { value: node.value.match(HEX)[0] } });
        }
      },
    };
  },
};

/** Every string literal reachable inside a className expression. */
function collectStrings(expr, out = []) {
  if (!expr) return out;
  if (expr.type === "Literal" && typeof expr.value === "string") {
    out.push({ node: expr, value: expr.value });
  } else if (expr.type === "TemplateLiteral") {
    for (const q of expr.quasis) out.push({ node: expr, value: q.value.raw });
  } else if (expr.type === "CallExpression") {
    for (const a of expr.arguments) collectStrings(a, out);
  } else if (expr.type === "LogicalExpression" || expr.type === "BinaryExpression") {
    collectStrings(expr.left, out);
    collectStrings(expr.right, out);
  } else if (expr.type === "ConditionalExpression") {
    collectStrings(expr.consequent, out);
    collectStrings(expr.alternate, out);
  } else if (expr.type === "ArrayExpression") {
    for (const el of expr.elements) collectStrings(el, out);
  } else if (expr.type === "ObjectExpression") {
    for (const prop of expr.properties) {
      if (prop.type === "Property" && prop.key?.type === "Literal") {
        out.push({ node: prop.key, value: String(prop.key.value) });
      }
    }
  }
  return out;
}
