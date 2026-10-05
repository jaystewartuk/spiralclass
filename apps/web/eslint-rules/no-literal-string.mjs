// Local ESLint rule: forbid hardcoded user-facing strings in JSX. An
// edit-time backstop on the files listed in eslint.config.mjs; the repo-wide
// guarantee is the ban in tests/i18n-guard.test.ts.
//
// Flags: raw JSX text containing a letter, and string-literal values on the
// user-facing attributes below. Use t("key") from the catalog instead.
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

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow hardcoded user-facing strings; use the i18n catalog (t)." },
    messages: {
      literal: 'Hardcoded user-facing string. Move it to the shared catalog and use t("key").',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXText(node) {
        const text = node.value.trim();
        if (text && HAS_LETTER.test(text)) {
          context.report({ node, messageId: "literal" });
        }
      },
      JSXAttribute(node) {
        const name = typeof node.name.name === "string" ? node.name.name : "";
        if (!USER_FACING_ATTRS.has(name) || !node.value) return;
        let literal = null;
        if (node.value.type === "Literal" && typeof node.value.value === "string") {
          literal = node.value.value;
        } else if (
          node.value.type === "JSXExpressionContainer" &&
          node.value.expression.type === "Literal" &&
          typeof node.value.expression.value === "string"
        ) {
          literal = node.value.expression.value;
        }
        if (literal && HAS_LETTER.test(literal)) {
          context.report({ node, messageId: "literal" });
        }
      },
    };
  },
};
