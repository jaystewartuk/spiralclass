"use client";

import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";

// Public chart barrel. recharts (+ its d3 deps) is one of the largest client
// dependencies; loading it eagerly bloated the initial JS of all 13 admin routes
// that show a chart. Here the implementations load lazily from a separate chunk
// via next/dynamic, so recharts is fetched only when a chart actually renders.
// This module stays a Client Component so the `ssr: false` split is legal even
// though the admin pages that consume it are Server Components.
//
// Color tokens are re-exported from the recharts-free chart-tokens module so a
// caller that only needs a color never pulls the chart chunk.
export { CHART_CATEGORY_COLORS, CHART_SERIES_COLOR } from "./chart-tokens";

// Sized placeholder while the chunk loads — reserves a chart-sized block so the
// lazy swap-in doesn't shift surrounding layout (CLS).
function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("h-chart w-full animate-pulse rounded-md bg-muted/30", className)}
      aria-hidden
    />
  );
}

export const CategoryBarChart = dynamic(
  () => import("./chart-impl").then((m) => m.CategoryBarChart),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

export const TrendLineChart = dynamic(() => import("./chart-impl").then((m) => m.TrendLineChart), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});
