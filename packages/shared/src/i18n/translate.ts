import { strings, type StringKey } from "./catalog";
import { DEFAULT_LOCALE, type AppLocale } from "./locales";
import { createTFrom, type TFunction } from "./translate-core";

export { interpolate, createTFrom, type TFunction, type CatalogTable } from "./translate-core";

// Runtime string resolution over the whole catalog: the server's half. Every
// language's strings are imported here, so a Client Component must not reach
// this module. It binds one language's table through ./translate-core instead
// (apps/web/src/components/locale-catalog/). Framework-free: no React, no
// next/headers.

/** A `t(key, vars)` accessor bound to a locale, over the full catalog. The
 * interpolation, plural and fallback rules are createTFrom's. */
export function createT(locale: AppLocale): TFunction {
  return createTFrom(locale, strings[locale] ?? strings[DEFAULT_LOCALE], strings[DEFAULT_LOCALE]);
}

/** Whether a string names a catalog entry. */
export function isStringKey(value: unknown): value is StringKey {
  return typeof value === "string" && Object.hasOwn(strings[DEFAULT_LOCALE], value);
}

/**
 * The message for a failed validation, in the reader's language.
 *
 * A schema is a module-level constant: it is built once, with no request and
 * so no reader. A message written into one is therefore in exactly one
 * language for everybody — which is how "Da una razón breve." came to be the
 * answer every teacher got, whatever she read. The alternative, rebuilding
 * each schema per request with the locale passed in, works but has to be
 * remembered at every schema and quietly is not.
 *
 * So a schema's message is a catalog KEY, and this is the one place it is
 * turned into words. A message that is not a key is passed through untouched:
 * the validators that are still built per locale already return finished
 * sentences. No message at all gets the caller's fallback.
 */
export function issueMessage(
  error: { issues: readonly { message?: string }[] },
  t: TFunction,
  fallback: StringKey,
): string {
  const message = error.issues[0]?.message;
  if (!message) return t(fallback);
  return isStringKey(message) ? t(message) : message;
}

/** Legacy inline-dictionary accessor: `translate({ en, "es" }, locale)`.
 * Retained for the handful of call sites that predate the key-based catalog;
 * prefer createT()/t(key) for new copy so the string lives in the catalog. */
export function translate<T extends string>(dict: Record<AppLocale, T>, locale: AppLocale): T {
  return dict[locale];
}
