"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE } from "@spiralclass/shared";
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
