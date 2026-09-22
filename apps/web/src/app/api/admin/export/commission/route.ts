import { requireAdmin } from "@/lib/admin";
import { csvResponse, toCsv } from "@/lib/csv";
import { getCommissionReport } from "@/lib/subscriptions/admin-metrics";

// Ambassador commission CSV: one row per attributed PAID invoice (50% of net,
// first 12 months), plus a per-ambassador subtotal. Finance role.
export async function GET() {
  await requireAdmin("finance");
  const report = await getCommissionReport();

  const headers = [
    "ambassador",
    "referred_teachers",
    "teacher",
    "invoice_id",
    "period_start",
    "net_minor_units",
    "payable_minor_units",
  ] as const;

  const rows: unknown[][] = [];
  for (const a of report) {
    for (const li of a.lineItems) {
      rows.push([
        a.ambassador,
        a.referredTeacherCount,
        li.teacherName,
        li.invoiceId,
        li.periodStart.toISOString(),
        li.netMinorUnits,
        li.payableMinorUnits,
      ]);
    }
    // Per-ambassador subtotal row.
    rows.push([
      a.ambassador,
      a.referredTeacherCount,
      "— SUBTOTAL —",
      "",
      "",
      a.totalNetMinorUnits,
      a.totalPayableMinorUnits,
    ]);
  }

  return csvResponse("ambassador-commission", toCsv(headers, rows));
}
