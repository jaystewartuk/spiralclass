"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { formatMinorUnits, formatGbp, type ChartDatum } from "@spiralclass/shared";
import { CHART_SERIES_COLOR } from "./chart-tokens";

// The recharts-backed chart implementations. Split out of chart.tsx so recharts
// (and its d3 transitive deps — one of the largest client dependencies) lands in
// its own lazily-loaded chunk instead of every admin route's initial JS. The
// barrel in chart.tsx loads this on demand via next/dynamic.

// Server Components can't pass functions as props to Client Components (RSC
// serialization boundary), so callers pick a formatter by name instead of
// handing one in directly.
const VALUE_FORMATTERS = {
  number: (n: number) => n.toLocaleString(),
  minorUnits: formatMinorUnits,
  // Always pence — the Financial Intelligence estimate layer (D-86) is
  // GBP-only, so its charts need a formatter that never consults a row's
  // currency, distinct from the MXN-default `minorUnits` one.
  gbp: formatGbp,
} as const;
export type ValueFormat = keyof typeof VALUE_FORMATTERS;

const BAR_HEIGHT = 32;

// One horizontal bar per row, category + value always direct-labeled on the
// chart itself so identity/magnitude never rides on color alone. Used for the
// small (<=8 row) category breakdowns across the admin console.
export function CategoryBarChart({
  data,
  height,
  valueFormat = "number",
  className,
}: {
  data: ChartDatum[];
  height?: number;
  valueFormat?: ValueFormat;
  className?: string;
}) {
  const valueFormatter = VALUE_FORMATTERS[valueFormat];
  const resolvedHeight = height ?? Math.max(120, data.length * (BAR_HEIGHT + 12) + 16);

  return (
    <div className={cn("w-full", className)} style={{ height: resolvedHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 4 }}>
          <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            width={132}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "var(--radius)",
              color: "hsl(var(--popover-foreground))",
              fontSize: 12,
            }}
            formatter={(value) => [valueFormatter(Number(value)), ""]}
            labelFormatter={() => ""}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={BAR_HEIGHT}>
            {data.map((d) => (
              <Cell key={d.key} fill={d.color} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(value: unknown) => valueFormatter(Number(value))}
              style={{ fill: "hsl(var(--foreground))", fontSize: 12, fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// A single-series time trend (e.g. signups/month). Unlike CategoryBarChart's
// horizontal bars for a handful of categories, this reads left-to-right as a
// sequence — the shape recharts' LineChart is built for. Still direct-labels
// every point (LabelList) rather than relying on the reader to trace the axis.
export function TrendLineChart({
  data,
  height = 220,
  valueFormat = "number",
  className,
}: {
  data: ChartDatum[];
  height?: number;
  valueFormat?: ValueFormat;
  className?: string;
}) {
  const valueFormatter = VALUE_FORMATTERS[valueFormat];

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 20, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
          />
          <YAxis hide domain={[0, (max: number) => Math.ceil(max * 1.2) || 1]} />
          <Tooltip
            cursor={{ stroke: "hsl(var(--border))" }}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "var(--radius)",
              color: "hsl(var(--popover-foreground))",
              fontSize: 12,
            }}
            formatter={(value) => [valueFormatter(Number(value)), ""]}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={CHART_SERIES_COLOR}
            strokeWidth={2}
            dot={{ r: 3, fill: CHART_SERIES_COLOR, strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          >
            <LabelList
              dataKey="value"
              position="top"
              formatter={(value: unknown) => valueFormatter(Number(value))}
              style={{ fill: "hsl(var(--foreground))", fontSize: 12, fontWeight: 600 }}
            />
          </Line>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
