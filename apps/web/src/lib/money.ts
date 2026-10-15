// Money formatting lives in @spiralclass/shared, beside the currency exponents
// it reads. Re-exported here as the import surface the app uses.
export {
  mxnFormatter,
  formatMinorUnits,
  formatPriceForBuyer,
  minorUnitsToMajor,
  majorToMinorUnits,
  currencyExponent,
  formatGbp,
} from "@spiralclass/shared";
