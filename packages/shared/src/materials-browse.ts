// Level-first navigation for the teacher's reusable material library — the
// single rule deciding WHICH of three things the Materials surface shows, so
// web (?level= in the URL) and mobile (screen state) can never drift apart.
//
// Why level is the hierarchy and everything else stays a filter: `levelId` is
// the only axis on a library material that is mandatory, single-valued, AND
// totally ordered (Level.position). Focus tags are optional and many-per-item —
// a material can be grammar + format + theme at once — so they can only ever
// narrow a set, never partition it. The product already treats level as
// primary everywhere else (the student browse ceiling, the three `visibility`
// modes are DEFINED relative to level, the class page's "at their level"
// shelf); the flat list page was the one surface that demoted it to a peer
// filter chip defaulting to "All".
//
// This is deliberately NOT folders. Nothing moves, nothing is stored: the
// shelf is a view over `levelId`, which every material already carries. Re-tag
// a material to B1 and it re-homes itself with no drag-and-drop, no empty
// folder left behind, and it keeps all of its cross-cutting tags — none of
// which a real folder tree can do.
//
// Pure and dependency-free (no DB, no React, no URL parsing) so both platforms
// share one behaviour and it unit-tests in isolation.

// Sentinel for the "Todos los materiales" escape hatch — the flat, all-levels
// list the library has always been. A real level id never collides with it
// (level ids are uuids), and it has to be an explicit value rather than "no
// level" because "no level" is what selects the hub.
export const ALL_LEVELS = "all";

export type MaterialsBrowseMode =
  // The landing view: pick a level. No material rows are fetched at all.
  | { kind: "hub" }
  // Every level at once — reached via "Todos los materiales", a search from
  // the hub, or any inbound deep link that already carries other narrowing.
  | { kind: "all" }
  // One level's shelf. `levelId` is always one of the teacher's own levels.
  | { kind: "level"; levelId: string };

export type MaterialsBrowseInput = {
  // The raw, untrusted level selection: a level id, ALL_LEVELS, or null when
  // nothing is selected.
  levelParam?: string | null;
  // The teacher's own active level ids. A `levelParam` outside this set is
  // ignored rather than trusted — same posture as the page's other filters.
  levelIds: readonly string[];
  // True when the surface is already narrowed by something other than level
  // (search text, a category/type/visibility chip, the archived shelf, or a
  // page number). Such a state must render the LIST, never the hub — otherwise
  // an existing bookmark like ?type=file&view=archived would silently land on
  // a level picker with its filters dropped.
  hasOtherNarrowing?: boolean;
};

// Resolves the three-way navigation state. Precedence, highest first:
//
//   1. A valid level id             -> that level's shelf
//   2. ALL_LEVELS                   -> the flat list, explicitly chosen
//   3. Any other active narrowing   -> the flat list (deep links keep working)
//   4. No levels configured at all  -> the flat list (an empty hub is a
//                                      dead end; the page's own "no levels
//                                      yet" card is the real answer)
//   5. Otherwise                    -> the hub
export function resolveMaterialsBrowseMode(input: MaterialsBrowseInput): MaterialsBrowseMode {
  const { levelParam, levelIds, hasOtherNarrowing } = input;
  if (levelParam && levelParam !== ALL_LEVELS && levelIds.includes(levelParam)) {
    return { kind: "level", levelId: levelParam };
  }
  if (levelParam === ALL_LEVELS) return { kind: "all" };
  if (hasOtherNarrowing) return { kind: "all" };
  if (levelIds.length === 0) return { kind: "all" };
  return { kind: "hub" };
}

// The level id to actually FILTER by. Only a real shelf filters on level —
// both "hub" (which fetches nothing) and "all" (deliberately unfiltered)
// resolve to null, so callers can feed this straight into the query layer.
export function browseLevelFilter(mode: MaterialsBrowseMode): string | null {
  return mode.kind === "level" ? mode.levelId : null;
}

// The value to write back into the surface's own state (web: the `level` query
// param; mobile: the screen's selection), so navigating around inside the list
// doesn't bounce back to the hub. Null means "omit it" — i.e. the hub.
export function browseLevelParam(mode: MaterialsBrowseMode): string | null {
  if (mode.kind === "level") return mode.levelId;
  if (mode.kind === "all") return ALL_LEVELS;
  return null;
}

// ---- Level grouping for compact in-page pickers -----------------------------
//
// The class-detail page's "attach from library" control is the same
// find-a-material problem as the Materials page, but it can NOT use the
// hub-and-spoke shape above: it's a multi-select inside a larger form, and
// replacing the list with a drill-down would either lose a selection made in
// another level or hide the fact that one exists. So the picker keeps ONE list
// and applies level-first as *structure* — level headings in ladder order, plus
// an optional single-level narrowing — with the checked set living outside the
// list so it survives narrowing untouched.
//
// Deliberately NOT defaulted to the class student's own level: the class page
// already has a separate opt-in "at their level" shelf
// (teachers.auto_surface_level_materials) doing exactly that job. This picker
// stays a full-library browse so the two don't collapse into each other.

export type LevelledMaterial = { levelId: string | null; levelLabel: string };

export type MaterialLevelGroup<T> = {
  // null = the trailing "no level" bucket. A reusable library item always has a
  // level in practice (it's required to create one), so this should stay empty
  // — it exists because the schema's `levelId` is nullable to accommodate
  // booking-scoped rows, not because a library item is expected to lack one.
  levelId: string | null;
  levelLabel: string;
  items: T[];
};

// Groups picker options by level, in FIRST-ENCOUNTER order.
//
// Encounter order IS ladder order because every caller's query sorts by
// `level: { position: "asc" }` — see the `libraryMaterial.findMany` in both
// apps/web/src/app/(app)/dashboard/classes/[bookingId]/page.tsx and
// apps/web/src/app/api/mobile/teacher/bookings/[bookingId]/route.ts. That's why
// this takes no level ladder: threading the teacher's full `Level[]` into the
// mobile booking payload just to re-derive an order the query already applied
// would be redundant. If you ever change one of those `orderBy` clauses, this
// grouping silently loses its ladder order — change it here too.
export function groupMaterialsByLevel<T extends LevelledMaterial>(
  items: readonly T[],
  noLevelLabel: string,
): MaterialLevelGroup<T>[] {
  const groups: MaterialLevelGroup<T>[] = [];
  const indexByLevel = new Map<string | null, number>();
  for (const item of items) {
    const key = item.levelId ?? null;
    const at = indexByLevel.get(key);
    if (at === undefined) {
      indexByLevel.set(key, groups.length);
      groups.push({
        levelId: key,
        levelLabel: key === null ? noLevelLabel : item.levelLabel,
        items: [item],
      });
    } else {
      groups[at].items.push(item);
    }
  }
  return groups;
}
