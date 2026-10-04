"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, formatMinorUnits, localizedHref } from "@spiralclass/shared";
import { createT, type AppLocale, type TFunction } from "@/lib/i18n-translate";

// The context default only applies to a tree with no LocaleProvider above it,
// which the layouts make sure never happens — so a wrong value here would be
// wrong invisibly. DEFAULT_LOCALE, like every other unforced choice.
const LocaleContext = createContext<AppLocale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): AppLocale {
  return useContext(LocaleContext);
}

/** Client-side `t(key, vars)` bound to the active locale — the Client Component
 * counterpart of the server's `getT()`. Prefer this over inline
 * `locale === "en" ? … : …` ternaries so new copy lives in the shared catalog. */
export function useT(): TFunction {
  const locale = useLocale();
  return useMemo(() => createT(locale), [locale]);
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
