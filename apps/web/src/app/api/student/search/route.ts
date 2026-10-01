import { NextResponse } from "next/server";
import { requireApiStudent } from "@/lib/api/auth";
import { handle } from "@/lib/api/route";
import { getPreferredLocale } from "@/lib/i18n";
import { createT } from "@/lib/i18n-translate";
import { helpSearchEntries } from "@/lib/search/help-entries";
import { studentSearchRecords } from "@/lib/search/student-records";

// The student portal's site-search index: her teachers, her classes and the
// student help articles. The counterpart of /api/teacher/search; see there.
export async function GET(req: Request): Promise<NextResponse> {
  return handle(async () => {
    const student = await requireApiStudent(req);
    const locale = await getPreferredLocale();
    const records = await studentSearchRecords({
      student,
      locale,
      t: createT(locale),
      now: new Date(),
    });
    const entries = [...records, ...helpSearchEntries("student", locale)];
    return NextResponse.json({ entries }, { headers: { "Cache-Control": "private, no-store" } });
  });
}
