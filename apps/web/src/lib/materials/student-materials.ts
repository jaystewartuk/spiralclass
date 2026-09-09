import { toYMD } from "@/lib/tz";
import type { MaterialTiming } from "@/lib/notifications/materials";

// Aggregated cross-booking view for the student detail page (teacher-facing):
// every material that touched any of a student's classes, filterable and
// groupable several ways. Kept DB/JSX-free so the filter/group logic is cheap
// to unit test — the query that produces the items lives in ./class-history.
//
// This used to cover only booking-scoped file/link attachments, which made it
// structurally unable to answer the question teachers actually ask of it
// ("what did we use last class?"): a class's own lesson content and every
// reusable library item were both filtered out. See ./class-history for the
// three sources it now unions.

// "all" = everything that touched the class, prepared or not.
// "sent" = only what the student can see right now (send time elapsed).
// "used" = only what was actually opened during the class (ClassMaterialUse).
export type StudentMaterialsFilter = "all" | "sent" | "used";
export type StudentMaterialsGroupBy = "class" | "date" | "type";

export const DEFAULT_MATERIALS_FILTER: StudentMaterialsFilter = "all";
export const DEFAULT_MATERIALS_GROUP_BY: StudentMaterialsGroupBy = "class";

/**
 * Narrow a `?mf=` / `?mg=` value from the URL.
 *
 * Lives here rather than in the page because the page is no longer the only
 * reader: the student screen's tab-href builder has to round-trip the same two
 * values, and two parsers for one parameter is how a link ends up pointing at
 * a filter the page will not honour. Anything unrecognised falls back to the
 * default rather than erroring — a hand-edited or stale link should still show
 * the teacher her materials.
 */
export function parseMaterialsFilter(v: string | string[] | undefined): StudentMaterialsFilter {
  const value = Array.isArray(v) ? v[0] : v;
  return value === "sent" || value === "used" ? value : DEFAULT_MATERIALS_FILTER;
}

export function parseMaterialsGroupBy(v: string | string[] | undefined): StudentMaterialsGroupBy {
  const value = Array.isArray(v) ? v[0] : v;
  return value === "date" || value === "type" ? value : DEFAULT_MATERIALS_GROUP_BY;
}

// file / link open externally; content is native Markdown rendered in-app.
export type StudentMaterialKind = "file" | "link" | "content";

export type StudentMaterialItem = {
  // Stable list key. A material can appear once per class, so neither the
  // material id nor the booking id is unique on its own.
  id: string;
  materialId: string;
  bookingId: string;
  classStart: Date;
  label: string | null;
  storagePath: string | null;
  linkUrl: string | null;
  // The first few hundred characters of a native-content body — enough to
  // derive a display title from its first heading (see materialDisplayTitle),
  // never the whole body. Null for a file/link row.
  bodyHead: string | null;
  attachmentKind: StudentMaterialKind;
  // Where the material lives: "class" = private to this booking (D-69
  // booking-scoped row), "library" = a reusable item attached to or opened in
  // this class. Drives the badge, not the grouping.
  origin: "class" | "library";
  // An external URL (file/link). Null for native content, which is read in-app
  // via `href` instead.
  viewUrl: string | null;
  // In-app destination — the class this material belongs to. Always present:
  // it is where a history row wants to land (the class, in context), and the
  // only destination native content has, since there is nothing external to
  // open for it.
  href: string;
  // Null when nothing was ever scheduled for delivery — a class's own always-
  // visible content, or a library item that was only ever opened on the call.
  sendTiming: MaterialTiming | null;
  // Whether the student can actually see it yet (materialSendTimeElapsed).
  // Always true for an always-visible class content row.
  sent: boolean;
  // A ClassMaterialUse row exists: the teacher opened this ON the call. This
  // is the signal the whole feature exists for — "prepared" and "used" are
  // different facts and a class routinely has more of the former.
  usedInClass: boolean;
  createdAt: Date;
};

export type StudentMaterialGroup = {
  key: string;
  items: StudentMaterialItem[];
};

export function filterStudentMaterials(
  items: StudentMaterialItem[],
  filter: StudentMaterialsFilter,
): StudentMaterialItem[] {
  if (filter === "sent") return items.filter((m) => m.sent);
  if (filter === "used") return items.filter((m) => m.usedInClass);
  return items;
}

// Buckets already-sorted materials into display groups, one bucket per
// distinct key in first-seen order (callers sort the input first — e.g. by
// class date descending — so groups come out in that same order).
export function groupStudentMaterials(
  items: StudentMaterialItem[],
  groupBy: StudentMaterialsGroupBy,
  tz: string,
): StudentMaterialGroup[] {
  const keyOf = (m: StudentMaterialItem): string => {
    if (groupBy === "class") return m.bookingId;
    if (groupBy === "date") return toYMD(m.classStart, tz);
    return m.attachmentKind;
  };

  const groups: StudentMaterialGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const m of items) {
    const key = keyOf(m);
    const idx = indexByKey.get(key);
    if (idx == null) {
      indexByKey.set(key, groups.length);
      groups.push({ key, items: [m] });
    } else {
      groups[idx].items.push(m);
    }
  }
  return groups;
}

// A material's display title, for a list that mixes labelled attachments with
// a class's own lesson content — which has no `label` at all by design (a
// booking's content carries no level/visibility/label/tags of its own, see
// MaterialForm's ExistingContentMaterial). Without a fallback every content
// row in the history renders as the same generic word, which is precisely the
// rows the teacher is scanning for.
//
// Order: the teacher's own label, then the body's first Markdown heading (what
// she'd call it if asked), then the hostname of a link, then a generic word.
// Pure and string-only so it is testable without a DB or a renderer.
export function materialDisplayTitle(
  m: { label?: string | null; bodyHead?: string | null; linkUrl?: string | null },
  fallbacks: { content: string; file: string; link: string },
): string {
  const label = m.label?.trim();
  if (label) return label;

  const heading = firstMarkdownHeading(m.bodyHead ?? null);
  if (heading) return heading;

  if (m.bodyHead != null) return fallbacks.content;

  const url = m.linkUrl?.trim();
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return fallbacks.link;
    }
  }
  return fallbacks.file;
}

// First ATX heading (`# ...` through `###### ...`) in a Markdown body, trimmed
// of its hashes and any trailing closing hashes, capped so a pathological
// single-line body can't stretch the list. Null when there is no heading.
export function firstMarkdownHeading(body: string | null): string | null {
  if (!body) return null;
  for (const raw of body.split("\n", 40)) {
    const line = raw.trim();
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/\s*#+\s*$/, "").trim();
    if (text) return text.slice(0, 120);
  }
  return null;
}

/**
 * `materialDisplayTitle`, applied to a STUDENT-FACING library entry, where a
 * material may carry a body and a file and a link at once (the unified
 * material) and `attachmentKind` names which of the three it primarily is.
 *
 * The only thing this adds is that kind. The bare resolver reaches for a link's
 * hostname whenever `linkUrl` is set, which titles an uploaded worksheet after
 * whatever URL happens to hang off it — so the link is offered as a name only
 * when the link IS the material. Everything else (the teacher's own label
 * first, then the body's first heading) is the shared behaviour, and having one
 * resolver is the point: a material should not be called two different things
 * on the student's shelf and in her teacher's history.
 */
export function studentMaterialTitle(
  entry: {
    label: string | null;
    body?: string | null;
    linkUrl?: string | null;
    attachmentKind: StudentMaterialKind;
  },
  fallbacks: { content: string; file: string; link: string },
): string {
  return materialDisplayTitle(
    {
      label: entry.label,
      bodyHead: entry.body ?? null,
      linkUrl: entry.attachmentKind === "link" ? entry.linkUrl : null,
    },
    fallbacks,
  );
}
