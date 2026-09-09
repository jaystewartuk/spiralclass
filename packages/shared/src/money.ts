// Shared money formatting. Amounts are integer minor units (centavos for MXN);
// each amount also carries a currency code recording what it's denominated in.
//
// One source of truth so web and mobile render identical strings. es-MX renders
// the symbol as a bare `$`, which is ambiguous with USD (and most other
// dollar/peso currencies), so every formatted amount carries an explicit code
// suffix (`$1,500.00 MXN`). Number formatting is deliberately locale-independent
// (always es-MX grouping) so the two platforms never drift on separators; the
// currency, not the UI language, drives the symbol and decimals.
//
// The app is genuinely multi-currency: a teacher picks one currency for her
// whole business at onboarding from a curated per-rail list (D-64/D-124,
// pricing-currency.ts), and MXN is only that list's default, not its content.
// Every stored amount records its own currency explicitly, and formatting is
// currency-aware — the divisor comes from the currency's minor-unit exponent
// rather than a hardcoded /100, so a zero-decimal currency (JPY, CLP, PYG)
// renders correctly rather than a hundredth of itself.

// Minor-unit exponent (number of decimal places) per ISO-4217 currency. The
// vast majority of currencies are 2-decimal, so the map only lists the
// exceptions and everything else falls back to 2. This is what keeps the
// minor↔major divisor from being a hardcoded /100: JPY (0-decimal) divides
// by 1, KWD (3-decimal) by 1000.
//
// BOTH SIDES ARE CURRENCY-AWARE, AND THEY MUST STAY THAT WAY TOGETHER.
// `majorToMinorUnits` still defaults its `currency` to MXN for the handful of
// legacy readers that pass none, but every PRICE-ENTRY path now passes the
// teacher's own `pricingCurrency` explicitly — web via the
// `PricingCurrencyProvider` context, the server actions and mobile routes via
// `currencyForTeacher(teacher)`, mobile via the row's own `currency`.
//
// That matters because the two halves used to disagree: entry always
// multiplied by 100 while `formatMinorUnits` divided by the REAL exponent, so a
// 0-decimal price (CLP, JPY, KRW, VND) typed as 20000 was stored as 2,000,000
// and rendered as 2,000,000. The four 0-decimal codes that were missing from
// the map below (PYG, UGX, XAF, XOF) were wrong in BOTH directions and so
// round-tripped correctly by accident; they are added now, in the same change
// that made entry currency-aware, because fixing either half alone would have
// turned a latent bug into a live one.
//
// If you add a currency to the curated pricing list, add its exponent here in
// the same change unless it is 2-decimal.
const MINOR_UNIT_EXPONENTS: Record<string, number> = {
  // 0-decimal currencies (no minor unit).
  JPY: 0,
  KRW: 0,
  CLP: 0,
  VND: 0,
  ISK: 0,
  HUF: 0,
  PYG: 0,
  UGX: 0,
  XAF: 0,
  XOF: 0,
  // 3-decimal currencies.
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  JOD: 3,
};

const DEFAULT_EXPONENT = 2;

// Decimal places for a currency's minor unit. Unknown codes assume the 2-decimal
// majority so a new currency renders sanely before it's added to the map above.
export function currencyExponent(currency: string): number {
  return MINOR_UNIT_EXPONENTS[currency.toUpperCase()] ?? DEFAULT_EXPONENT;
}

// One Intl.NumberFormat per currency, built lazily. Intl formatters are
// relatively expensive to construct, and RN Hermes supports Intl.NumberFormat
// (currency style) reliably, so caching keeps the hot path cheap on both
// platforms.
//
// `currencyDisplay: "narrowSymbol"` is load-bearing, not cosmetic. The locale
// here is es-MX, and an ICU locale renders only its OWN currency by symbol —
// every other one falls back to the bare alphabetic code. `formatMinorUnits` then
// appends the code for provenance, so the default `currencyDisplay` DOUBLED it
// for every currency except MXN: "GBP 7.99 GBP", "USD 1,500.00 USD",
// "EUR 1,500.00 EUR". MXN was the only correct output, which is why this
// survived — the first teachers all priced in pesos, and D-64 opened pricing to
// ~40 currencies without the rendering following. "narrowSymbol" asks for the
// symbol regardless of locale, so the suffix disambiguates instead of repeating:
// "£7.99 GBP", "$1,500.00 USD", "€1,500.00 EUR".
//
// That suffix is also what makes "narrowSymbol" safe. Narrow symbols collapse
// distinct currencies onto a shared glyph (MXN and USD are both "$" here), so
// the glyph alone would be ambiguous — the appended code is the disambiguator.
// The two have to stay together; don't drop the suffix from `formatMinorUnits`.
const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  const code = currency.toUpperCase();
  let formatter = formatters.get(code);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: code,
        currencyDisplay: "narrowSymbol",
      });
    } catch {
      // "narrowSymbol" needs ICU 62+. Every engine this ships on today has it
      // (Node, every current browser, Hermes on Android 11+), but the mobile
      // app is FROZEN and still installed on real phones, so an older
      // Android's ICU has to degrade to the previous rendering rather than
      // throw inside a price label. The amount and the code suffix are correct
      // in both branches; only the glyph is lost.
      formatter = new Intl.NumberFormat("es-MX", { style: "currency", currency: code });
    }
    formatters.set(code, formatter);
  }
  return formatter;
}

// Backwards-compatible MXN formatter export (some call sites imported it
// directly). Prefer formatMinorUnits(amount, currency) for new code.
export const mxnFormatter = formatterFor("MXN");

// Format an integer minor-unit amount in its currency, e.g.
// formatMinorUnits(150_000) → "$1,500.00 MXN", formatMinorUnits(1500, "JPY") →
// "¥1,500 JPY". `currency` defaults to "MXN" so every existing call site keeps
// its exact output; pass the row's stored currency to carry provenance through.
//
// The code suffix is appended only when the formatter didn't already emit it.
// `narrowSymbol` (see formatterFor) gets a real glyph for currencies CLDR has
// one for, but a code with no narrow symbol in this locale's data still falls
// back to the bare code — KWD, and any future addition CLDR doesn't cover.
// Appending unconditionally is what produced "KWD 150.000 KWD", the same
// doubling narrowSymbol fixed everywhere else, so the check is the half of the
// fix that doesn't depend on CLDR coverage. Those currencies read as
// "KWD 150.000": no symbol, but the code is present exactly once, which is the
// invariant callers actually rely on.
// The minor→major divisor, in ONE place.
//
// Both formatters need it, and having it written out twice is not merely
// duplication: `scripts/mutation-spotcheck.mjs` proves the money tests catch an
// off-by-one in this exponent by finding this exact expression and mutating it,
// which requires the expression to be unique in the file. A second copy made
// the target ambiguous and took the full gate red — so the duplication was
// load-bearing in a way that is easy to reintroduce by accident. Keep it here,
// and keep the parameter named `code`.
function toMajorUnits(minorUnits: number, code: string): number {
  return minorUnits / 10 ** currencyExponent(code);
}

export function formatMinorUnits(minorUnits: number, currency: string = "MXN"): string {
  const code = currency.toUpperCase();
  const formatted = formatterFor(code).format(toMajorUnits(minorUnits, code));
  return formatted.includes(code) ? formatted : `${formatted} ${code}`;
}

// Buyer-facing prices, formatted so the SYMBOL cannot be misread — for the
// public booking funnel, where the reader is a stranger who has never seen
// this teacher's currency before.
//
// `formatMinorUnits` above renders MXN as "$1,500.00 MXN", which is right for
// someone already inside the product and wrong for the one place it matters
// most. `narrowSymbol` deliberately strips a currency's disambiguating prefix
// — that is what "narrow" MEANS — so MXN, CLP, ARS, COP and UYU all collapse
// to a bare "$" in every locale, including "en". An English-reading visitor
// scanning a price list reads "$6,400.00" as six thousand US dollars and
// leaves; the trailing code arrives after the number has already landed. The
// real figure was about twenty dollars.
//
// `currencyDisplay: "symbol"` is the non-narrow form, and under an English
// locale every currency this product supports comes back unambiguous:
// MXN "MX$1,500.00", BRL "R$1,500.00", CLP "CLP 1,500", GBP "£1,500.00",
// USD "$1,500.00" — a bare "$" is emitted for USD and nothing else, which is
// exactly what "$" means to that reader.
//
// So no code suffix is appended here, and none is needed: a currency with no
// symbol in this locale's data (KWD, CLP, ARS) already formats AS its code.
// Appending would reproduce the "KWD 150.000 KWD" doubling the function above
// exists to avoid.
//
// The locale is the caller's, not this module's: on the public funnel that is
// the teacher's own `booking_page_locale`, so a Spanish-facing page still
// reads "$1,500.00" for MXN — correct, because a reader in that market cannot
// misread their own currency's symbol.
export function formatPriceForBuyer(minorUnits: number, currency: string, locale: string): string {
  // EVERYTHING is inside the try, including reading `currency`. A price label
  // must never be the thing that breaks the highest-traffic public page, and
  // the two ways this throws are both reachable from outside: an invalid
  // locale tag (Intl wants hyphenated BCP-47 and rejects the underscored
  // "en_US" this codebase uses for OpenGraph) and a caller that has no
  // currency to give — a row selected without the column, which the typed
  // signature cannot prevent at a boundary where the data comes from Prisma.
  try {
    const code = currency.toUpperCase();
    const major = toMajorUnits(minorUnits, code);
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      currencyDisplay: "symbol",
    }).format(major);
  } catch {
    // Falls back to the in-product rendering: ambiguous, but correct, and it
    // owns the historical MXN default rather than this function growing a
    // second copy of it.
    return formatMinorUnits(minorUnits, currency);
  }
}

// Convert an integer minor-unit amount to its major-unit number (e.g. centavos
// → pesos), rounding the input. `currency` selects the divisor's exponent so
// 0-decimal currencies (JPY) don't get a phantom /100. Defaults to MXN.
export function minorUnitsToMajor(minorUnits: number, currency: string = "MXN"): number {
  return Math.round(minorUnits) / 10 ** currencyExponent(currency);
}

// Convert a major-unit amount (e.g. pesos) into integer minor units (centavos),
// rounding to the currency's exponent. The mirror of minorUnitsToMajor and the
// one place major→minor rounding should live: for JPY (0-decimal) this is a
// plain round, for MXN/USD a *100, for KWD a *1000 — never a hardcoded *100.
// Defaults to MXN. Callers pass a pre-validated finite number.
export function majorToMinorUnits(pesos: number, currency: string = "MXN"): number {
  return Math.round(pesos * 10 ** currencyExponent(currency));
}

// GBP-specific formatter (Financial Intelligence dashboard, D-86). The one
// thing it still does differently from formatMinorUnits is omit the code suffix:
// the whole /admin/economics view is already GBP-only, so " GBP" on every
// figure would be noise (contrast formatMinorUnits, which is multi-currency by
// row and needs the code to disambiguate its narrow symbol). The "£" glyph is
// no longer the difference — formatMinorUnits renders symbols for every currency
// now, see formatterFor above.
const gbpFormatter = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

// Format an integer GBP pence amount, e.g. formatGbp(123_456) → "£1,234.56".
export function formatGbp(pence: number): string {
  return gbpFormatter.format(pence / 100);
}
