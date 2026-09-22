// Pure data-shaping for the admin-metrics bar charts, kept apart from rendering
// (recharts) so ordering, labels and colors have one definition; this file only
// turns a counts record into an ordered, labeled, colored series.

export type ChartDatum = {
  key: string;
  label: string;
  value: number;
  color: string;
};

// `order` is the fixed category order — callers must not derive it from the
// counts record (e.g. Object.keys), since that would let the color a category
// gets shift with which categories happen to be present.
export function toBarSeries<K extends string>(
  counts: Partial<Record<K, number>>,
  order: readonly K[],
  labels: Record<K, string>,
  colors: Record<K, string>,
): ChartDatum[] {
  return order.map((key) => ({
    key,
    label: labels[key],
    value: counts[key] ?? 0,
    color: colors[key],
  }));
}
