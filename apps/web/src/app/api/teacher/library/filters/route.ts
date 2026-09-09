import { NextResponse } from "next/server";

import { isAppLocale, DEFAULT_LOCALE, type TeacherLibraryFilterMeta } from "@spiralclass/shared";
import { getCurrentTeacher } from "@/lib/auth";
import { getTeacherLevels } from "@/lib/levels";
import { getTeacherFocusGroups } from "@/lib/focus-tags";
import type { AppLocale } from "@/lib/i18n";

// The filter metadata behind the in-call "My library" tab
// (components/video/call-library-browser.tsx): her level ladder and her
// category/theme taxonomy, which seed the chip rows above the list.
//
// It exists because that component used to bootstrap itself from a route in a
// tree that has since been deleted, so the endpoint a web component depends on
// now lives in the web API tree under its own name.
//
// It is NOT a copy of that bootstrap. The old one also built a first page
// of materials, the template list and the entitlement flags, every one of
// which this caller discards — it renders chips, then fetches ../materials for
// the list itself. Carrying the unused half across would have meant a
// materials query, a template query and an entitlements load on every
// call-sheet open, to populate fields nothing reads.
export async function GET(): Promise<NextResponse> {
  const teacher = await getCurrentTeacher();
  if (!teacher) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const locale: AppLocale = isAppLocale(teacher.locale) ? teacher.locale : DEFAULT_LOCALE;
  const [levels, focusGroups] = await Promise.all([
    getTeacherLevels(teacher.id),
    getTeacherFocusGroups(teacher.id, teacher.targetLanguage, locale),
  ]);

  return NextResponse.json({
    levels: levels.map((l) => ({ id: l.id, label: l.label })),
    focusGroups,
  } satisfies TeacherLibraryFilterMeta);
}
