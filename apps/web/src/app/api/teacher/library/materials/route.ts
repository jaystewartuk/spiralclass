import { NextResponse } from "next/server";

import type { TeacherLibraryMaterialsPage } from "@spiralclass/shared";
import { getCurrentTeacher } from "@/lib/auth";
import { getTeacherLevels } from "@/lib/levels";
import { getStorageProvider } from "@/lib/storage/provider";
import { pickMaterialsUrl } from "@/lib/storage/signed-urls";
import { listLibraryMaterialsCursor } from "@/lib/library/library-queries";
import { mapLibraryRowToAdmin, parseLibraryListParams } from "@/lib/materials/library-admin";

// One keyset page of the teacher's reusable library, server-filtered and
// sorted — the engine behind the in-call "My library" tab's search, chips and
// infinite scroll (components/video/call-library-browser.tsx). Scoped on
// teacherId (bookingId: null) by the shared where-builder.
//
// Moved here out of a route tree that has since been deleted, so a web
// component no longer reaches into it. The query engine is untouched — the same
// parseLibraryListParams and listLibraryMaterialsCursor, so filter semantics
// cannot drift from the ones the component's buildLibraryQueryParams encodes.
export async function GET(req: Request): Promise<NextResponse> {
  const teacher = await getCurrentTeacher();
  if (!teacher) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const { filters, sort, cursor, limit } = parseLibraryListParams(
    teacher.id,
    new URL(req.url).searchParams,
  );
  const [page, levels] = await Promise.all([
    listLibraryMaterialsCursor(filters, { sort, take: limit, cursor }),
    getTeacherLevels(teacher.id),
  ]);
  const levelLabel = new Map(levels.map((l) => [l.id, l.label]));
  const storage = getStorageProvider();
  const mintUrl = (m: { storagePath: string | null; linkUrl: string | null }) =>
    pickMaterialsUrl(storage, m);
  const items = await Promise.all(
    page.rows.map((r) => mapLibraryRowToAdmin(r, levelLabel, mintUrl)),
  );

  return NextResponse.json({
    items,
    nextCursor: page.nextCursor,
  } satisfies TeacherLibraryMaterialsPage);
}
