import type { StringKey } from "./catalog";
import { intlLocale, type AppLocale } from "./locales";

// The catalog-free half of runtime string resolution. Nothing here imports a
// catalog (the StringKey import is type-only, erased at build), so a browser
// that needs one language can load exactly that one: apps/web's per-language
// catalog modules hand their own table to createTFrom, and the full
// every-language `strings` object stays on the server (createT, ./translate).

/** Replace `{name}` placeholders in a template with `vars.name`. Unknown
 * placeholders resolve to an empty string, matching the catalog's authored
 * expectation that every `{var}` in a string is supplied by its caller. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ""));
}

export type TFunction = (key: StringKey, vars?: Record<string, string | number>) => string;

/** One language's strings: every StringKey, plus its plural variants. */
export type CatalogTable = Readonly<Record<string, string | undefined>>;

/**
 * CLDR plural category for a count, memoised per locale because
 * `new Intl.PluralRules` is not cheap and this runs inside render.
 */
const PLURAL_RULES = new Map<AppLocale, Intl.PluralRules>();
function pluralCategory(locale: AppLocale, count: number): string {
  let rules = PLURAL_RULES.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(intlLocale(locale));
    PLURAL_RULES.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * Build a `t(key, vars)` accessor over one language's table, with an optional
 * second table to fall back to.
 *
 * PLURALS. When `vars.count` is a number, a `<key>_<category>` entry wins over
 * the base key — `_one`, `_other`, and whatever else CLDR says for the locale.
 * The base key stays required and stays the fallback, so every string that
 * does not care about number is untouched and no call site had to change.
 *
 * This exists because the catalog was writing plurals into the template:
 * "{count} classes × {min} min" rendered "1 classes × 50 min" on any package
 * whose count was one but which was not flagged `singleClass`. A guard flag at
 * the call site cannot fix that class of bug generally — some other string
 * will always be next — and Spanish and French do not agree with English on
 * where the boundaries fall anyway, which is precisely what Intl.PluralRules
 * knows and a hand-rolled `count === 1` does not.
 *
 * FALLBACK ORDER is deliberate: every string the requested locale has, before
 * anything from the fallback. Preferring a fallback plural variant over the
 * requested locale's base string would render one English line in the middle
 * of a Spanish page, which is worse than a slightly wrong plural. The
 * catalog's completeness guard makes every base key exist in every language,
 * so for a real key the fallback is never reached — which is why the browser
 * can be given one table and nothing else.
 */
export function createTFrom(
  locale: AppLocale,
  table: CatalogTable,
  fallback: CatalogTable = table,
): TFunction {
  return (key, vars) => {
    const variant =
      typeof vars?.count === "number" ? `${key}_${pluralCategory(locale, vars.count)}` : undefined;

    const template =
      (variant ? table[variant] : undefined) ??
      table[key] ??
      (variant ? fallback[variant] : undefined) ??
      fallback[key] ??
      key;
    return interpolate(template, vars);
  };
}
