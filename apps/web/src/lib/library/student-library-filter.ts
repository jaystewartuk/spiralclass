import type { MaterialTag, StudentMaterialSource } from "@spiralclass/shared";

// The pure half of the student's materials page (app/(student)/my-classes/
// materials) — how a shelf of materials is narrowed down and counted. Kept
// DB-free and JSX-free so it is unit-testable, and free of server-only imports
// so the client-side toolbar can run exactly the same code the server used to
// build its counts. One implementation, no drift between the two.
//
// Filtering runs on the CLIENT, deliberately, where the equivalent teacher-side
// surface (dashboard/materials) filters on the server from `?q=`. The two pages
// are not the same problem: the teacher's library is paginated, so a server
// round-trip re-mints signed URLs for one page of rows, while this page has no
// pagination and mints one signed URL per file in the WHOLE library on every
// render. Round-tripping a keystroke there would re-presign the lot. With no
// JavaScript the toolbar simply never renders and the full list shows, which is
// what this page did before it had one.

/** The source buckets a student can narrow to. `all` is every material. */
export const STUDENT_MATERIAL_FILTERS = ["all", "assigned", "class", "browse"] as const;

export type StudentMaterialFilter = (typeof STUDENT_MATERIAL_FILTERS)[number];

export type StudentMaterialCounts = Record<StudentMaterialFilter, number>;

export function isStudentMaterialFilter(value: unknown): value is StudentMaterialFilter {
  return (
    typeof value === "string" && (STUDENT_MATERIAL_FILTERS as readonly string[]).includes(value)
  );
}

/**
 * Case- AND accent-insensitive search text.
 *
 * The accent fold is not a nicety here: two of the three shipped locales are
 * accented languages, and a student typing "practica" on a keyboard without a
 * dead key would otherwise fail to find "Práctica". Composed characters are
 * decomposed (NFD) so the combining marks become separate code points, then
 * dropped.
 */
export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * How much of a material's body is worth searching.
 *
 * The body is markdown that can run to thousands of characters, and every one
 * of them would be shipped to the browser a second time purely to be searched.
 * The opening of a lesson is where its subject is named, so this is where the
 * matches are; the cap keeps the payload proportional to the list.
 */
const BODY_SEARCH_CHARS = 600;

/**
 * The haystack for one material: everything a student might plausibly type to
 * find it again. Built once on the server and handed to the toolbar, so the
 * body never crosses the wire in full.
 */
export function studentMaterialSearchText(entry: {
  title: string;
  unit?: string | null;
  levelLabel?: string | null;
  tags?: MaterialTag[];
  body?: string | null;
}): string {
  const parts = [
    entry.title,
    entry.unit ?? "",
    entry.levelLabel ?? "",
    ...(entry.tags ?? []).map((tag) => tag.label),
    (entry.body ?? "").slice(0, BODY_SEARCH_CHARS),
  ];
  return normalizeForSearch(parts.filter(Boolean).join(" "));
}

/** Does an already-normalized haystack match a raw, user-typed query? */
export function matchesSearch(searchText: string, query: string): boolean {
  const needle = normalizeForSearch(query);
  if (!needle) return true;
  // Every whitespace-separated term must appear, in any order — "b1 verbs"
  // finds a B1 material tagged Verbs, which a single-substring match would not.
  return needle.split(/\s+/).every((term) => searchText.includes(term));
}

/** How many materials sit in each source bucket. `all` is the total. */
export function countStudentMaterials(sources: StudentMaterialSource[]): StudentMaterialCounts {
  const counts: StudentMaterialCounts = { all: 0, assigned: 0, class: 0, browse: 0 };
  for (const source of sources) {
    counts.all += 1;
    counts[source] += 1;
  }
  return counts;
}

/**
 * Seconds as a clock reading — `4:12`, or `1:02:03` past the hour. Null for a
 * missing or nonsensical duration, so a caller can drop the label entirely
 * rather than print `0:00` next to audio that plainly is not zero seconds long.
 */
export function formatMediaDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}
