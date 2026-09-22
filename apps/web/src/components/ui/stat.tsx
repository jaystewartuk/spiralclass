import { Card, CardContent } from "@/components/ui/card";

// Shared KPI tile, extracted from the triplicated local `Stat` in
// admin/page.tsx, admin/money/page.tsx, and admin/costs/page.tsx (D-86 S3) so
// the Financial Intelligence overview panel reuses it instead of a 4th copy.
export function StatCard({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: number | string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold ${danger ? "text-destructive" : ""}`}>
          {value}
        </div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
