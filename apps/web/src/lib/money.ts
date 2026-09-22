// Money formatting now lives in @spiralclass/shared so web and mobile render
// identical MXN strings. Re-exported here so existing `@/lib/money` imports
// keep working.
export {
  mxnFormatter,
  formatMinorUnits,
  formatPriceForBuyer,
  minorUnitsToMajor,
  majorToMinorUnits,
  currencyExponent,
  formatGbp,
} from "@spiralclass/shared";
