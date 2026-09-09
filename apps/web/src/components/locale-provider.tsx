"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createT, type AppLocale, type TFunction } from "@/lib/i18n-translate";

const LocaleContext = createContext<AppLocale>("es-MX");

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
