// Chart color tokens — kept in a recharts-free module so callers (and the
// chart.tsx barrel) can import them without pulling the recharts/d3 bundle into
// their chunk. The chart components themselves live in chart-impl.tsx and are
// loaded lazily (see chart.tsx).

// Chart-only categorical palette (--chart-1..4 in globals.css) — kept
// separate from the badge/status tokens (--success/--warning/--destructive/
// --info), which are reserved for state and never doubled as a plain
// "series N" fill. Validated as a set (dataviz skill: lightness band, chroma
// floor, CVD adjacent-pair separation, contrast) for both light and dark.
export const CHART_CATEGORY_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
] as const;

// Single-series magnitude charts (e.g. a funnel of stage counts) use one hue
// rather than a distinct color per bar — the bars aren't different
// categories competing for identity, they're one series across stages.
export const CHART_SERIES_COLOR = "hsl(var(--chart-1))";
