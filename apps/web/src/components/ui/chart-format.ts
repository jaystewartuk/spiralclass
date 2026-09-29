import { formatGbp, formatMinorUnits } from "@spiralclass/shared";

// How a chart labels its values. Kept free of recharts so it can be unit
// tested and imported by the lazy chart chunk alike.
//
// `minorUnits` REQUIRES a currency, at the type level. It used to call
// formatMinorUnits with none, which defaults to MXN, so every money chart in
// the admin console labelled GBP subscription revenue, GBP costs and GMV in
// any currency as pesos (#27). A money value without its currency is not a
// value, and the type now refuses to draw one.
export type ChartValueFormat =
  | { valueFormat?: "number"; currency?: never }
  | { valueFormat: "minorUnits"; currency: string }
  // Always pence: the Financial Intelligence estimate layer (D-86) is GBP-only.
  | { valueFormat: "gbp"; currency?: never };

export function chartValueFormatter(format: ChartValueFormat): (n: number) => string {
  switch (format.valueFormat) {
    case "minorUnits": {
      const { currency } = format;
      return (n) => formatMinorUnits(n, currency);
    }
    case "gbp":
      return formatGbp;
    default:
      return (n) => n.toLocaleString();
  }
}
