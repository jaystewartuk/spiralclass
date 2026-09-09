// The teacher's fully-customizable dashboard **layout** — the shared, platform-
// neutral model behind the mobile Home screen's drag-and-drop customizer (and,
// later, the web dashboard). It supersedes the flat `dashboardTileOrder`
// ({key,hidden}[]) that only ordered the single "Day to day" grid: a layout is
// an ordered list of *sections*, each either a fixed **widget** (booking link,
// upcoming classes, growth checklist, payments) or a **tiles** group (a
// reorderable NavTileGrid). The teacher can reorder sections, reorder tiles
// within a group, move a tile from one group into another, and hide any section
// or tile.
//
// As with `nav.ts`, this file owns *structure*, not routes — each app maps a
// NavKey to its own href. All functions here are pure so the mobile drag screen
// (and the unit tests) can reason about reordering without a running device.

import {
  DEFAULT_DASHBOARD_TILE_KEYS,
  navGroup,
  resolveDashboardTiles,
  type DashboardTilePref,
  type NavKey,
} from "./nav";

// Fixed, single-purpose cards that aren't collections of tiles. They can be
// reordered among the tile groups and hidden, but no tile can be dropped into
// them.
export type DashboardWidgetKey = "bookingLink" | "upcoming" | "growth" | "payments";

export const DASHBOARD_WIDGET_KEYS: DashboardWidgetKey[] = [
  "bookingLink",
  "upcoming",
  "growth",
  "payments",
];

// The reorderable tile-grid groups. Tiles may be moved *between* these.
export type DashboardTileGroupKey = "page" | "content" | "dayToDay";

export const DASHBOARD_TILE_GROUP_KEYS: DashboardTileGroupKey[] = ["page", "content", "dayToDay"];

export type DashboardSectionKey = DashboardWidgetKey | DashboardTileGroupKey;

export type DashboardSectionKind = "widget" | "tiles";

export type DashboardSection = {
  key: DashboardSectionKey;
  kind: DashboardSectionKind;
  hidden: boolean;
  // Always present; empty for widget sections. Only the visible, in-order tiles
  // a group renders.
  tiles: DashboardTilePref[];
};

export type DashboardLayout = { sections: DashboardSection[] };

const WIDGET_KEY_SET = new Set<string>(DASHBOARD_WIDGET_KEYS);
const TILE_GROUP_KEY_SET = new Set<string>(DASHBOARD_TILE_GROUP_KEYS);

/** The canonical default tile keys for a tile group, in declaration order. The
 * `page`/`content` groups mirror the shared IA groups; `dayToDay` is the
 * historical customizable grid (DEFAULT_DASHBOARD_TILE_KEYS). Keys legitimately
 * repeat across groups (e.g. `leads` is both a "page" tool and a day-to-day
 * shortcut) — duplicates *across* groups are allowed; duplicates *within* a
 * group are not. */
export function defaultTileGroupKeys(group: DashboardTileGroupKey): NavKey[] {
  if (group === "dayToDay") return [...DEFAULT_DASHBOARD_TILE_KEYS];
  return navGroup(group).map((item) => item.key);
}

// The canonical top-to-bottom section order, matching the historical hardcoded
// Home layout: the booking link and upcoming classes lead, the growth checklist
// and the tile groups sit in the middle, and the one-time payments setup is
// demoted to the bottom.
export const DEFAULT_DASHBOARD_SECTION_ORDER: DashboardSectionKey[] = [
  "bookingLink",
  "upcoming",
  "growth",
  "page",
  "content",
  "dayToDay",
  "payments",
];

function sectionKind(key: DashboardSectionKey): DashboardSectionKind {
  return WIDGET_KEY_SET.has(key) ? "widget" : "tiles";
}

/** An empty section shell (no tiles) — tiles are filled in afterward so global
 * tile uniqueness (a tile lives in exactly one group) is enforced centrally. */
function sectionShell(key: DashboardSectionKey): DashboardSection {
  return { key, kind: sectionKind(key), hidden: false, tiles: [] };
}

/** Fill each tile group with its canonical default tiles, in canonical section
 * order, skipping any tile already present in an earlier group. A tile's
 * *canonical home* is therefore the first group (page → content → dayToDay) whose
 * defaults list it — this is what dedupes the historically-duplicated shortcuts
 * (e.g. `leads` lands in "page", not also in "Day to day"). Only fills tiles
 * that are absent everywhere, so it never disturbs a teacher's arrangement. */
function injectCanonicalTiles(sections: DashboardSection[]) {
  const present = new Set<NavKey>();
  for (const s of sections) for (const t of s.tiles) present.add(t.key);
  for (const group of DASHBOARD_TILE_GROUP_KEYS) {
    const target = sections.find((s) => s.key === group);
    if (!target || target.kind !== "tiles") continue;
    for (const key of defaultTileGroupKeys(group)) {
      if (present.has(key)) continue;
      present.add(key);
      target.tiles.push({ key, hidden: false });
    }
  }
}

/** The layout a teacher who has never customized sees. */
export function defaultDashboardLayout(): DashboardLayout {
  const sections = DEFAULT_DASHBOARD_SECTION_ORDER.map(sectionShell);
  injectCanonicalTiles(sections);
  return { sections };
}

function isValidNavKey(key: unknown): key is NavKey {
  if (typeof key !== "string") return false;
  try {
    // Every default tile group key is a real NavKey; anything a client sends
    // that isn't a known tile key is dropped. We only ever persist tile keys
    // drawn from the group defaults, so validate against that universe.
    return ALL_DEFAULT_TILE_KEYS.has(key as NavKey);
  } catch {
    return false;
  }
}

const ALL_DEFAULT_TILE_KEYS = new Set<NavKey>(
  DASHBOARD_TILE_GROUP_KEYS.flatMap((g) => defaultTileGroupKeys(g)),
);

type SavedSectionShape = { key?: unknown; hidden?: unknown; tiles?: unknown };

/** Reconcile a teacher's saved layout with the canonical defaults, so the model
 * self-heals as the product changes:
 *  - unknown/duplicate section keys are dropped; sections appear in the saved
 *    order, then any canonical section the teacher hasn't seen is appended at the
 *    end (an explicit saved order always leads).
 *  - tile keys are globally unique: a tile lives in exactly one group. Unknown
 *    keys, within-group duplicates, and cross-group duplicates (first occurrence
 *    in saved section order wins) are all dropped.
 *  - a canonical tile key that appears in *no* saved group (a brand-new product
 *    surface) is added once to its canonical home group — but a tile the teacher
 *    moved or hid is left exactly where they put it.
 *  - `null`/`undefined` (never customized) resolves to the full default layout.
 * The result always contains every canonical section exactly once, every widget
 * with an empty tile list, and each tile key at most once across the whole
 * layout. */
export function resolveDashboardLayout(saved: unknown): DashboardLayout {
  const savedSections = readSavedSections(saved);
  if (!savedSections) return defaultDashboardLayout();

  // 1. Ordered, de-duplicated section shells (tiles filled in step 2).
  const seenSections = new Set<string>();
  const sections: DashboardSection[] = [];
  const rawByKey = new Map<string, SavedSectionShape>();
  for (const raw of savedSections) {
    const key = raw?.key;
    if (typeof key !== "string") continue;
    if (!WIDGET_KEY_SET.has(key) && !TILE_GROUP_KEY_SET.has(key)) continue;
    if (seenSections.has(key)) continue;
    seenSections.add(key);
    const shell = sectionShell(key as DashboardSectionKey);
    shell.hidden = Boolean(raw?.hidden);
    sections.push(shell);
    rawByKey.set(key, raw);
  }
  for (const key of DEFAULT_DASHBOARD_SECTION_ORDER) {
    if (!seenSections.has(key)) {
      seenSections.add(key);
      sections.push(sectionShell(key));
    }
  }

  // 2. Fill tiles from the saved layout with GLOBAL de-duplication, preserving
  //    each group's saved order. First occurrence (in section order) of a key
  //    wins; later duplicates are dropped.
  const present = new Set<NavKey>();
  for (const section of sections) {
    if (section.kind !== "tiles") continue;
    for (const tile of readSavedTiles(rawByKey.get(section.key)?.tiles)) {
      if (present.has(tile.key)) continue;
      present.add(tile.key);
      section.tiles.push(tile);
    }
  }

  // 3. Add brand-new tile surfaces (absent everywhere) to their canonical home.
  injectCanonicalTiles(sections);

  return { sections };
}

function readSavedSections(saved: unknown): SavedSectionShape[] | null {
  if (saved == null) return null;
  if (Array.isArray(saved)) return saved as SavedSectionShape[];
  if (typeof saved === "object" && Array.isArray((saved as { sections?: unknown }).sections)) {
    return (saved as { sections: SavedSectionShape[] }).sections;
  }
  return null;
}

function readSavedTiles(raw: unknown): DashboardTilePref[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tiles: DashboardTilePref[] = [];
  for (const entry of raw) {
    const key = (entry as { key?: unknown })?.key;
    if (!isValidNavKey(key) || seen.has(key)) continue;
    seen.add(key);
    tiles.push({ key, hidden: Boolean((entry as { hidden?: unknown })?.hidden) });
  }
  return tiles;
}

/** Resolve a teacher's layout, migrating a pre-layout customization forward:
 * when the teacher has no saved `dashboardLayout` yet but *did* customize the
 * old flat `dashboardTileOrder`, seed the default layout's "Day to day" group
 * from that saved tile order so their existing arrangement carries over instead
 * of resetting to the default. Once they save a layout, `savedLayout` wins. */
export function resolveDashboardLayoutWithLegacyTiles(
  savedLayout: unknown,
  savedTiles: DashboardTilePref[] | null | undefined,
): DashboardLayout {
  if (savedLayout != null) return resolveDashboardLayout(savedLayout);
  const seeded = defaultDashboardLayout();
  const dayToDay = seeded.sections.find((s) => s.key === "dayToDay");
  if (dayToDay) dayToDay.tiles = resolveDashboardTiles(savedTiles);
  return resolveDashboardLayout(seeded);
}

/** Project the layout's "Day to day" group back to the flat `dashboardTileOrder`
 * shape the web app still reads, so a mobile customization keeps web's Day-to-day
 * card consistent. Returns the resolved default tiles when the layout has no
 * dayToDay group. */
export function dashboardTilesFromLayout(layout: DashboardLayout): DashboardTilePref[] {
  const dayToDay = layout.sections.find((s) => s.key === "dayToDay");
  return dayToDay ? dayToDay.tiles.map((t) => ({ key: t.key, hidden: t.hidden })) : [];
}

// ---------------------------------------------------------------------------
// Pure reordering primitives — driven by the mobile drag customizer, unit-tested
// here so correctness never depends on a running device.
// ---------------------------------------------------------------------------

export type DashboardFlatRow =
  | {
      type: "section";
      id: string;
      sectionKey: DashboardSectionKey;
      kind: DashboardSectionKind;
      hidden: boolean;
    }
  | { type: "tile"; id: string; sectionKey: DashboardSectionKey; tileKey: NavKey; hidden: boolean };

/** Flatten a layout into a single ordered list of draggable rows: each section
 * header followed by its tile rows. Row ids are globally stable: `sec:<key>` for
 * headers, `tile:<tileKey>` for tiles. Because a tile key is unique across the
 * whole layout (see resolveDashboardLayout), the tile id stays constant even as
 * the tile is dragged from one group into another — which is exactly what lets
 * the drag UI track the active row by id across a cross-container move. */
export function flattenDashboard(layout: DashboardLayout): DashboardFlatRow[] {
  const rows: DashboardFlatRow[] = [];
  for (const section of layout.sections) {
    rows.push({
      type: "section",
      id: `sec:${section.key}`,
      sectionKey: section.key,
      kind: section.kind,
      hidden: section.hidden,
    });
    if (section.kind === "tiles") {
      for (const tile of section.tiles) {
        rows.push({
          type: "tile",
          id: `tile:${tile.key}`,
          sectionKey: section.key,
          tileKey: tile.key,
          hidden: tile.hidden,
        });
      }
    }
  }
  return rows;
}

/** Rebuild a layout from a flat row list, assigning each tile row to the nearest
 * preceding tiles-section (skipping widget sections). A tile with no preceding
 * tiles-section attaches to the first tiles-section overall, so a tile is never
 * lost even if it lands above every group. Section hidden flags come from the
 * section rows; tile hidden flags from the tile rows. */
function layoutFromFlat(rows: DashboardFlatRow[]): DashboardLayout {
  const sections: DashboardSection[] = [];
  const byKey = new Map<DashboardSectionKey, DashboardSection>();
  for (const row of rows) {
    if (row.type === "section") {
      const section: DashboardSection = {
        key: row.sectionKey,
        kind: row.kind,
        hidden: row.hidden,
        tiles: [],
      };
      sections.push(section);
      byKey.set(row.sectionKey, section);
    }
  }
  const firstTilesSection = sections.find((s) => s.kind === "tiles");

  let currentTiles: DashboardSection | undefined;
  for (const row of rows) {
    if (row.type === "section") {
      currentTiles = row.kind === "tiles" ? byKey.get(row.sectionKey) : undefined;
      continue;
    }
    // A tile attaches to the group it now sits under, or the first group if it
    // somehow lands above every group. If the layout had no tiles group at all
    // (never happens in practice) the tile is simply dropped rather than crash.
    const target = currentTiles ?? firstTilesSection;
    if (target) pushUniqueTile(target, row.tileKey, row.hidden);
  }

  return { sections };
}

function pushUniqueTile(section: DashboardSection, key: NavKey, hidden: boolean) {
  if (section.tiles.some((t) => t.key === key)) return;
  section.tiles.push({ key, hidden });
}

function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Apply a single drag: the row at flat index `from` is moved so it ends up at
 * flat index `to` (draggable-list semantics). A *tile* moves as
 * a single row and is re-homed to whichever group it now sits under (this is how
 * a tile crosses into another container). A *section* moves as a whole block —
 * its header and all its tiles travel together, and it snaps to a section
 * boundary so it never splits another group. Out-of-range indices, or a no-op
 * move, return the layout unchanged. */
export function applyFlatMove(layout: DashboardLayout, from: number, to: number): DashboardLayout {
  const rows = flattenDashboard(layout);
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length || from === to) {
    return layout;
  }
  const moved = rows[from];

  if (moved.type === "tile") {
    return layoutFromFlat(arrayMove(rows, from, to));
  }

  // Section drag: a whole section moves as a unit, so translate the flat target
  // into a section-index move. The dragged row ends up "in" whichever section
  // flat index `to` belongs to; arrayMove on the section list then lands it
  // before (drag up) or after (drag down) that section without ever splitting
  // another group's tiles.
  const fromSectionIndex = layout.sections.findIndex((s) => s.key === moved.sectionKey);
  const toSectionIndex = sectionIndexAtFlatRow(rows, to);
  return moveSection(layout, fromSectionIndex, toSectionIndex);
}

/** The section index that flat row `flatIndex` belongs to — the last section
 * header at or before it. */
function sectionIndexAtFlatRow(rows: DashboardFlatRow[], flatIndex: number): number {
  let sectionIndex = -1;
  for (let i = 0; i <= flatIndex && i < rows.length; i += 1) {
    if (rows[i].type === "section") sectionIndex += 1;
  }
  return Math.max(0, sectionIndex);
}

/** Reorder whole sections: move the section at `from` to `to`. */
export function moveSection(layout: DashboardLayout, from: number, to: number): DashboardLayout {
  const n = layout.sections.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return layout;
  return { sections: arrayMove(layout.sections, from, to) };
}

/** Move a tile from one group to another (or reorder within a group). Dedupes
 * within the destination group; a no-op if either group key is unknown. */
export function moveTile(
  layout: DashboardLayout,
  fromSectionKey: DashboardSectionKey,
  tileKey: NavKey,
  toSectionKey: DashboardSectionKey,
  toIndex: number,
): DashboardLayout {
  const sections = layout.sections.map((s) => ({ ...s, tiles: s.tiles.slice() }));
  const source = sections.find((s) => s.key === fromSectionKey);
  const dest = sections.find((s) => s.key === toSectionKey);
  if (!source || !dest || dest.kind !== "tiles") return layout;

  const idx = source.tiles.findIndex((t) => t.key === tileKey);
  if (idx === -1) return layout;
  const [tile] = source.tiles.splice(idx, 1);

  // Avoid a duplicate if the destination already holds this key.
  const existing = dest.tiles.findIndex((t) => t.key === tile.key);
  if (existing !== -1) dest.tiles.splice(existing, 1);

  const clamped = Math.max(0, Math.min(toIndex, dest.tiles.length));
  dest.tiles.splice(clamped, 0, tile);
  return { sections };
}

/** Toggle a whole section's visibility. */
export function toggleSectionHidden(
  layout: DashboardLayout,
  sectionKey: DashboardSectionKey,
): DashboardLayout {
  return {
    sections: layout.sections.map((s) => (s.key === sectionKey ? { ...s, hidden: !s.hidden } : s)),
  };
}

/** Toggle a single tile's visibility within its group. */
export function toggleTileHidden(
  layout: DashboardLayout,
  sectionKey: DashboardSectionKey,
  tileKey: NavKey,
): DashboardLayout {
  return {
    sections: layout.sections.map((s) =>
      s.key === sectionKey
        ? {
            ...s,
            tiles: s.tiles.map((t) => (t.key === tileKey ? { ...t, hidden: !t.hidden } : t)),
          }
        : s,
    ),
  };
}
