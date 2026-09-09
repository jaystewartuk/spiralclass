import { strings, type StringKey } from "./catalog";
import { DEFAULT_LOCALE, type AppLocale } from "./locales";

// Runtime string resolution, shared by web and mobile so the two interpolate
// and fall back identically. This module is framework-free (no React, no
// next/headers, no expo) — each app wraps it in its own provider/hook.

/** Replace `{name}` placeholders in a template with `vars.name`. Unknown
 * placeholders resolve to an empty string, matching the catalog's authored
 * expectation that every `{var}` in a string is supplied by its caller. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ""));
}

export type TFunction = (key: StringKey, vars?: Record<string, string | number>) => string;

/**
 * CLDR plural category for a count, memoised per locale because
 * `new Intl.PluralRules` is not cheap and this runs inside render.
 */
const PLURAL_RULES = new Map<AppLocale, Intl.PluralRules>();
function pluralCategory(locale: AppLocale, count: number): string {
  let rules = PLURAL_RULES.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    PLURAL_RULES.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * Build a `t(key, vars)` accessor bound to a locale.
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
 * anything from the default locale. Preferring a default-locale plural variant
 * over the requested locale's base string would render one English line in the
 * middle of a Spanish page, which is worse than a slightly wrong plural.
 */
export function createT(locale: AppLocale): TFunction {
  const table = strings[locale] ?? strings[DEFAULT_LOCALE];
  const fallback = strings[DEFAULT_LOCALE];
  return (key, vars) => {
    const local = table as Record<string, string | undefined>;
    const base = fallback as Record<string, string | undefined>;
    const variant =
      typeof vars?.count === "number" ? `${key}_${pluralCategory(locale, vars.count)}` : undefined;

    const template =
      (variant ? local[variant] : undefined) ??
      local[key] ??
      (variant ? base[variant] : undefined) ??
      base[key] ??
      key;
    return interpolate(template, vars);
  };
}

/** Legacy inline-dictionary accessor: `translate({ en, "es-MX" }, locale)`.
 * Retained for the handful of call sites that predate the key-based catalog;
 * prefer createT()/t(key) for new copy so the string lives in the catalog. */
export function translate<T extends string>(dict: Record<AppLocale, T>, locale: AppLocale): T {
  return dict[locale];
}
