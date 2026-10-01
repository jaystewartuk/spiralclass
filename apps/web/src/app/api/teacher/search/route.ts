import { NextResponse } from "next/server";
import { requireApiOnboardedTeacher } from "@/lib/api/auth";
import { handle } from "@/lib/api/route";
import { getPreferredLocale } from "@/lib/i18n";
import { createT } from "@/lib/i18n-translate";
import { helpSearchEntries } from "@/lib/search/help-entries";
import { teacherSearchRecords } from "@/lib/search/teacher-records";

// The teacher's site-search index: her records and the teacher help articles,
// in the locale her screens render in. Fetched once each time the search
// dialog opens and filtered in the browser (lib/search/match.ts explains why
// the matching is not a query per keystroke). Takes no parameters — the only
// scope is the session's own teacher id.
export async function GET(req: Request): Promise<NextResponse> {
  return handle(async () => {
    const teacher = await requireApiOnboardedTeacher(req);
    const locale = await getPreferredLocale();
    const records = await teacherSearchRecords({
      teacher,
      locale,
      t: createT(locale),
      now: new Date(),
    });
    const entries = [...records, ...helpSearchEntries("teacher", locale)];
    // Names, emails and class times — never cacheable by anything in between.
    return NextResponse.json({ entries }, { headers: { "Cache-Control": "private, no-store" } });
  });
}
