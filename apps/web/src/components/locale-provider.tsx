"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, formatMinorUnits, localizedHref } from "@spiralclass/shared";
import { createTFrom, type CatalogTable, type TFunction } from "@spiralclass/shared/translate-core";
import type { AppLocale } from "@/lib/i18n-translate";

// The reader's language, and the one catalog table that speaks it.
//
// Only one table, ever: this module and everything a Client Component imports
// must not reach the full catalog (`strings`, `createT`), because a browser
// that imports it downloads every language — 400 kB gzipped across three, of
// which a reader uses one. The table arrives from a per-language module in
// ./locale-catalog/, which the server's <LocaleProvider> (./locale-catalog)
// picks; the page then loads that language's chunk and no other.
type LocaleValue = { locale: AppLocale; t: TFunction };

// The context default only applies to a tree with no provider above it, which
// the layouts make sure never happens — so a wrong value here would be wrong
// invisibly. DEFAULT_LOCALE, like every other unforced choice, and keys
// rendered as themselves rather than a second language's copy.
const LocaleContext = createContext<LocaleValue>({
  locale: DEFAULT_LOCALE,
  t: createTFrom(DEFAULT_LOCALE, {}),
});

/** Binds one language's table. Rendered by ./locale-catalog/<language>.tsx,
 * never directly: those are what keep each language in its own chunk. */
export function CatalogProvider({
  locale,
  table,
  children,
}: {
  locale: AppLocale;
  table: CatalogTable;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ locale, t: createTFrom(locale, table) }), [locale, table]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): AppLocale {
  return useContext(LocaleContext).locale;
}

/** Client-side `t(key, vars)` bound to the active locale — the Client Component
 * counterpart of the server's `getT()`. Prefer this over inline
 * `locale === "en" ? … : …` ternaries so new copy lives in the shared catalog. */
export function useT(): TFunction {
  return useContext(LocaleContext).t;
}

/** `formatMinorUnits` bound to the active locale (D-197): the price's own
 * currency, written the way this reader writes numbers. */
export function useFormatMoney(): (minorUnits: number, currency?: string) => string {
  const locale = useLocale();
  return useCallback(
    (minorUnits: number, currency?: string) => formatMinorUnits(minorUnits, currency, locale),
    [locale],
  );
}

/** An href to a public page in the active locale's URL (D-193): `/pricing`
 * becomes `/es/pricing` in a Spanish tree. A link that stays in the language
 * it was rendered in is what keeps a client-side navigation safe, because the
 * root layout, which carries the language too, is not re-rendered by one.
 * Paths that are not public pages come back unchanged. */
export function useLocalizedHref(): (href: string) => string {
  const locale = useLocale();
  return useCallback((href: string) => localizedHref(href, locale), [locale]);
}
