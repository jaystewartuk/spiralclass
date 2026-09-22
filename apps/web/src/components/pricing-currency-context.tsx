"use client";

import { createContext, useContext } from "react";
import { DEFAULT_PRICING_CURRENCY } from "@spiralclass/shared";

// The acting teacher's own pricing currency (D-64), published once by the
// `(app)` layout so every Client Component that reads or writes one of HER
// money fields agrees on its denomination.
//
// Why a context rather than a prop on each form: the same currency is needed
// by six unrelated client forms (package templates, custom student price,
// discounts, referrals, and the two label sites inside them), several of them
// nested under Server Component pages that would otherwise each have to
// re-query the teacher and thread it down. It is one immutable value for the
// whole authenticated teacher shell — exactly what context is for.
//
// It is load-bearing for correctness, not just for labels: `majorToMinorUnits`
// is currency-aware and its default is MXN, so a call site that omits the
// currency multiplies a 0-decimal price (CLP, JPY, KRW, VND) by 100. Read it
// here and pass it, rather than letting the default decide.
const PricingCurrencyContext = createContext<string>(DEFAULT_PRICING_CURRENCY);

export function PricingCurrencyProvider({
  currency,
  children,
}: {
  currency: string;
  children: React.ReactNode;
}) {
  return (
    <PricingCurrencyContext.Provider value={currency}>{children}</PricingCurrencyContext.Provider>
  );
}

/** The acting teacher's pricing currency, e.g. "GBP". Falls back to the
 * platform default only outside the `(app)` shell, where there is no acting
 * teacher to have one. */
export function usePricingCurrency(): string {
  return useContext(PricingCurrencyContext);
}
