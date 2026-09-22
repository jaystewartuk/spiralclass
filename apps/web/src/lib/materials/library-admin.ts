import type { LibraryMaterialAdmin } from "@spiralclass/shared";
import { materialFileKind } from "@spiralclass/shared";
import type { LibraryFilters, LibraryListRow } from "@/lib/library/library-queries";

// Maps a raw library row (lib/library/library-queries LIBRARY_LIST_SELECT) to
// the wire shape `LibraryMaterialAdmin`. Kind is derived with a single
// precedence — body > file > link — so a combined item always buckets the same
// way.
export async function mapLibraryRowToAdmin(
  row: LibraryListRow,
  levelLabel: Map<string, string>,
  mintUrl: (m: { storagePath: string | null; linkUrl: string | null }) => Promise<string | null>,
): Promise<LibraryMaterialAdmin> {
  const kind: LibraryMaterialAdmin["attachmentKind"] =
    row.body != null ? "content" : row.storagePath ? "file" : "link";
  // Every row here is bookingId:null, so it always carries a level; the generated
  // select type just doesn't encode that.
  const levelId = row.levelId as string;
  return {
    id: row.id,
    levelId,
    levelLabel: levelLabel.get(levelId) ?? "—",
    visibility: row.visibility as LibraryMaterialAdmin["visibility"],
    unit: row.unit,
    label: row.label,
    attachmentKind: kind,
    viewUrl:
      kind === "content"
        ? null
        : await mintUrl({ storagePath: row.storagePath, linkUrl: row.linkUrl }),
    // Same rule and the same reason as getCallMaterials: off the stored path,
    // so the in-call library tab can render a picked PDF/image in place
    // instead of sending the teacher out to a browser tab mid-lesson.
    fileKind: kind === "file" ? materialFileKind(row.storagePath) : null,
    body: kind === "content" ? row.body : null,
    source:
      kind === "content"
        ? ((row.contentSource as LibraryMaterialAdmin["source"]) ?? "manual")
        : null,
    archived: row.archived,
    focusTagIds: row.focusTags.map((ft) => ft.focusTag.id),
  };
}

// Parses the mobile library-list query params into filters + a cursor sort +
// cursor/limit. `sort` is restricted to createdAt (recent/oldest) — the cursor
// can't safely keyset a nullable label (see library-queries). Unknown values
// fall back to safe defaults; every filter is still scoped by teacherId in the
// query, so a bogus level/category id just yields no rows.
export function parseLibraryListParams(
  teacherId: string,
  searchParams: URLSearchParams,
): {
  filters: LibraryFilters;
  sort: "recent" | "oldest";
  cursor: string | null;
  limit: number;
} {
  const typeRaw = searchParams.get("type");
  const type = typeRaw === "content" || typeRaw === "file" || typeRaw === "link" ? typeRaw : null;
  const visRaw = searchParams.get("visibility");
  const visibility =
    visRaw === "at_or_below" || visRaw === "exact" || visRaw === "all" ? visRaw : null;
  const sortRaw = searchParams.get("sort");
  const sort: "recent" | "oldest" = sortRaw === "oldest" ? "oldest" : "recent";
  const rawLimit = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 60) : 30;
  return {
    filters: {
      teacherId,
      archived: searchParams.get("archived") === "true",
      category: searchParams.get("category") || null,
      level: searchParams.get("level") || null,
      type,
      visibility,
      q: searchParams.get("q") || null,
    },
    sort,
    cursor: searchParams.get("cursor") || null,
    limit,
  };
}
