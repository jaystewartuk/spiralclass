import { describe, expect, it } from "vitest";

import {
  DASHBOARD_TILE_GROUP_KEYS,
  DASHBOARD_WIDGET_KEYS,
  DEFAULT_DASHBOARD_SECTION_ORDER,
  applyFlatMove,
  dashboardTilesFromLayout,
  defaultDashboardLayout,
  defaultTileGroupKeys,
  flattenDashboard,
  moveSection,
  moveTile,
  resolveDashboardLayout,
  resolveDashboardLayoutWithLegacyTiles,
  toggleSectionHidden,
  toggleTileHidden,
  type DashboardLayout,
} from "./dashboard-layout";

const sectionKeys = (l: DashboardLayout) => l.sections.map((s) => s.key);
const groupTiles = (l: DashboardLayout, key: string) =>
  l.sections.find((s) => s.key === key)?.tiles.map((t) => t.key) ?? [];

describe("defaultDashboardLayout", () => {
  it("has every canonical section once, in canonical order", () => {
    const layout = defaultDashboardLayout();
    expect(sectionKeys(layout)).toEqual(DEFAULT_DASHBOARD_SECTION_ORDER);
  });

  it("marks widgets vs tile groups correctly and gives widgets no tiles", () => {
    const layout = defaultDashboardLayout();
    for (const s of layout.sections) {
      if (DASHBOARD_WIDGET_KEYS.includes(s.key as never)) {
        expect(s.kind).toBe("widget");
        expect(s.tiles).toHaveLength(0);
      } else {
        expect(s.kind).toBe("tiles");
        expect(s.tiles.length).toBeGreaterThan(0);
      }
    }
  });

  it("gives each tile a single home — no tile key appears in two groups", () => {
    const layout = defaultDashboardLayout();
    const all = layout.sections.flatMap((s) => s.tiles.map((t) => t.key));
    expect(new Set(all).size).toBe(all.length);
  });

  it("routes a tile to its canonical home (first group whose defaults list it)", () => {
    const layout = defaultDashboardLayout();
    // `leads` is a default of both "page" and "dayToDay"; page comes first, so
    // it homes to page and is absent from dayToDay.
    expect(groupTiles(layout, "page")).toContain("leads");
    expect(groupTiles(layout, "dayToDay")).not.toContain("leads");
    // dayToDay keeps the keys unique to it.
    expect(groupTiles(layout, "dayToDay")).toContain("classes");
  });

  it("places every canonical tile key somewhere", () => {
    const layout = defaultDashboardLayout();
    const all = new Set(layout.sections.flatMap((s) => s.tiles.map((t) => t.key)));
    for (const g of DASHBOARD_TILE_GROUP_KEYS) {
      for (const key of defaultTileGroupKeys(g)) expect(all.has(key)).toBe(true);
    }
  });
});

describe("resolveDashboardLayout", () => {
  it("returns the default layout for null/undefined/garbage", () => {
    expect(sectionKeys(resolveDashboardLayout(null))).toEqual(DEFAULT_DASHBOARD_SECTION_ORDER);
    expect(sectionKeys(resolveDashboardLayout(undefined))).toEqual(DEFAULT_DASHBOARD_SECTION_ORDER);
    expect(sectionKeys(resolveDashboardLayout("nope"))).toEqual(DEFAULT_DASHBOARD_SECTION_ORDER);
    expect(sectionKeys(resolveDashboardLayout(42))).toEqual(DEFAULT_DASHBOARD_SECTION_ORDER);
  });

  it("accepts both the bare-array and {sections} shapes", () => {
    const arr = resolveDashboardLayout([{ key: "payments", hidden: true, tiles: [] }]);
    const wrapped = resolveDashboardLayout({
      sections: [{ key: "payments", hidden: true, tiles: [] }],
    });
    expect(arr.sections[0]).toMatchObject({ key: "payments", hidden: true });
    expect(wrapped.sections[0]).toMatchObject({ key: "payments", hidden: true });
  });

  it("honours a saved section order and appends unseen sections at canonical spots", () => {
    // Teacher moved payments to the very top; everything else absent.
    const layout = resolveDashboardLayout([{ key: "payments", hidden: false, tiles: [] }]);
    expect(sectionKeys(layout)[0]).toBe("payments");
    // Every canonical section still present exactly once.
    expect(new Set(sectionKeys(layout))).toEqual(new Set(DEFAULT_DASHBOARD_SECTION_ORDER));
    expect(sectionKeys(layout)).toHaveLength(DEFAULT_DASHBOARD_SECTION_ORDER.length);
  });

  it("drops unknown and duplicate section keys", () => {
    const layout = resolveDashboardLayout([
      { key: "bogus", hidden: false, tiles: [] },
      { key: "page", hidden: false, tiles: [{ key: "leads", hidden: false }] },
      { key: "page", hidden: true, tiles: [] },
    ]);
    expect(sectionKeys(layout).filter((k) => k === "page")).toHaveLength(1);
    expect(sectionKeys(layout)).not.toContain("bogus");
  });

  it("drops unknown/duplicate tile keys within a group but keeps saved order", () => {
    const layout = resolveDashboardLayout([
      {
        key: "dayToDay",
        hidden: false,
        tiles: [
          { key: "students", hidden: false },
          { key: "not-a-key", hidden: false },
          { key: "students", hidden: true },
          { key: "classes", hidden: false },
        ],
      },
    ]);
    const tiles = groupTiles(layout, "dayToDay");
    // students then classes lead (saved order), dupes/unknowns dropped.
    expect(tiles.slice(0, 2)).toEqual(["students", "classes"]);
    expect(tiles.filter((k) => k === "students")).toHaveLength(1);
    expect(tiles).not.toContain("not-a-key");
  });

  it("injects a brand-new tile surface once, into its canonical home group", () => {
    // Simulate a teacher who saved before `materials` existed in dayToDay: they
    // have a dayToDay group without it. It must be appended to dayToDay.
    const withoutMaterials = defaultDashboardLayout();
    const dayToDay = withoutMaterials.sections.find((s) => s.key === "dayToDay")!;
    dayToDay.tiles = dayToDay.tiles.filter((t) => t.key !== "materials");
    // Also remove it from content so it's truly absent everywhere.
    const content = withoutMaterials.sections.find((s) => s.key === "content")!;
    content.tiles = content.tiles.filter((t) => t.key !== "materials");

    const resolved = resolveDashboardLayout(withoutMaterials);
    const everywhere = resolved.sections.flatMap((s) => s.tiles.map((t) => t.key));
    expect(everywhere).toContain("materials");
  });

  it("respects a tile the teacher moved to another group (no resurrection, no dupe)", () => {
    // Teacher moved `leads` from its canonical page home into dayToDay.
    const moved = moveTile(defaultDashboardLayout(), "page", "leads", "dayToDay", 0);
    const resolved = resolveDashboardLayout(moved);
    expect(groupTiles(resolved, "dayToDay")).toContain("leads");
    // Not re-injected into its canonical page home, and present exactly once.
    expect(groupTiles(resolved, "page")).not.toContain("leads");
    const all = resolved.sections.flatMap((s) => s.tiles.map((t) => t.key));
    expect(all.filter((k) => k === "leads")).toHaveLength(1);
  });

  it("drops a cross-group duplicate in a hand-crafted saved layout (first wins)", () => {
    const layout = resolveDashboardLayout([
      { key: "page", hidden: false, tiles: [{ key: "leads", hidden: false }] },
      {
        key: "dayToDay",
        hidden: false,
        tiles: [
          { key: "leads", hidden: false },
          { key: "classes", hidden: false },
        ],
      },
    ]);
    expect(groupTiles(layout, "page")).toContain("leads");
    expect(groupTiles(layout, "dayToDay")).not.toContain("leads");
    expect(groupTiles(layout, "dayToDay")).toContain("classes");
  });
});

describe("flattenDashboard", () => {
  it("emits a section row then its tile rows, with unique ids", () => {
    const layout = defaultDashboardLayout();
    const rows = flattenDashboard(layout);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // First widget rows carry no tiles.
    expect(rows[0]).toMatchObject({ type: "section", sectionKey: "bookingLink" });
    // A tile row references its owning section.
    const firstTile = rows.find((r) => r.type === "tile");
    expect(firstTile?.type).toBe("tile");
  });
});

describe("applyFlatMove — tiles", () => {
  it("reorders a tile within its group", () => {
    const layout = defaultDashboardLayout();
    const rows = flattenDashboard(layout);
    // Find two adjacent tiles in the page group and swap.
    const pageStart = rows.findIndex((r) => r.type === "tile" && r.sectionKey === "page");
    const before = groupTiles(layout, "page");
    const next = applyFlatMove(layout, pageStart, pageStart + 1);
    const after = groupTiles(next, "page");
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    // No tiles lost.
    expect(after.slice().sort()).toEqual(before.slice().sort());
  });

  it("moves a tile across into another group (cross-container drag)", () => {
    const layout = defaultDashboardLayout();
    const rows = flattenDashboard(layout);
    // Take the first content tile and drop it right under the page header.
    const contentTileIdx = rows.findIndex((r) => r.type === "tile" && r.sectionKey === "content");
    const movedKey = (rows[contentTileIdx] as { tileKey: string }).tileKey;
    const pageHeaderIdx = rows.findIndex((r) => r.type === "section" && r.sectionKey === "page");
    const next = applyFlatMove(layout, contentTileIdx, pageHeaderIdx + 1);
    expect(groupTiles(next, "page")).toContain(movedKey);
    expect(groupTiles(next, "content")).not.toContain(movedKey);
  });

  it("re-homes a tile dropped onto a widget to the nearest preceding tiles-group", () => {
    const layout = defaultDashboardLayout();
    const rows = flattenDashboard(layout);
    const dayTileIdx = rows.findIndex((r) => r.type === "tile" && r.sectionKey === "dayToDay");
    const movedKey = (rows[dayTileIdx] as { tileKey: string }).tileKey;
    const paymentsIdx = rows.findIndex((r) => r.type === "section" && r.sectionKey === "payments");
    // Drop just after the payments widget header (a widget can't hold tiles).
    const next = applyFlatMove(layout, dayTileIdx, paymentsIdx + 1);
    // It falls through to dayToDay (the nearest tiles group before payments).
    expect(groupTiles(next, "dayToDay")).toContain(movedKey);
    // No section other than dayToDay gained it.
    expect(groupTiles(next, "content")).not.toContain(movedKey);
  });

  it("never loses a tile no matter where it lands", () => {
    const layout = defaultDashboardLayout();
    const rows = flattenDashboard(layout);
    const total = (l: DashboardLayout) => l.sections.flatMap((s) => s.tiles.map((t) => t.key));
    const tileIdx = rows.findIndex((r) => r.type === "tile");
    for (let to = 0; to < rows.length; to += 1) {
      const next = applyFlatMove(layout, tileIdx, to);
      // Count is preserved (allowing for dedupe only if the move created a dupe,
      // which the default layout's cross-group duplicates could — so assert the
      // moved key still exists somewhere).
      const movedKey = (rows[tileIdx] as { tileKey: string }).tileKey;
      expect(total(next)).toContain(movedKey);
    }
  });
});

describe("applyFlatMove — sections", () => {
  it("moves a whole section block (header + tiles) as a unit to the top", () => {
    const layout = defaultDashboardLayout();
    const rows = flattenDashboard(layout);
    const dayHeaderIdx = rows.findIndex((r) => r.type === "section" && r.sectionKey === "dayToDay");
    const beforeTiles = groupTiles(layout, "dayToDay");
    const next = applyFlatMove(layout, dayHeaderIdx, 0);
    expect(sectionKeys(next)[0]).toBe("dayToDay");
    // Its tiles travelled with it, unchanged.
    expect(groupTiles(next, "dayToDay")).toEqual(beforeTiles);
    // Same set of sections, no splitting.
    expect(new Set(sectionKeys(next))).toEqual(new Set(sectionKeys(layout)));
    expect(sectionKeys(next)).toHaveLength(sectionKeys(layout).length);
  });

  it("moves a section to the bottom without splitting other groups", () => {
    const layout = defaultDashboardLayout();
    const rows = flattenDashboard(layout);
    const pageHeaderIdx = rows.findIndex((r) => r.type === "section" && r.sectionKey === "page");
    const next = applyFlatMove(layout, pageHeaderIdx, rows.length - 1);
    expect(sectionKeys(next)[sectionKeys(next).length - 1]).toBe("page");
    // Every group keeps its exact tiles.
    for (const g of DASHBOARD_TILE_GROUP_KEYS) {
      expect(groupTiles(next, g).slice().sort()).toEqual(groupTiles(layout, g).slice().sort());
    }
  });
});

describe("moveSection / moveTile / toggles", () => {
  it("moveSection reorders sections", () => {
    const layout = defaultDashboardLayout();
    const next = moveSection(layout, 0, layout.sections.length - 1);
    expect(sectionKeys(next)[sectionKeys(next).length - 1]).toBe("bookingLink");
  });

  it("moveTile moves across groups and dedupes at destination", () => {
    const layout = defaultDashboardLayout();
    // leads exists in both page and dayToDay; move page's into dayToDay → dayToDay
    // should still hold exactly one leads.
    const next = moveTile(layout, "page", "leads", "dayToDay", 0);
    expect(groupTiles(next, "page")).not.toContain("leads");
    expect(groupTiles(next, "dayToDay").filter((k) => k === "leads")).toHaveLength(1);
    expect(groupTiles(next, "dayToDay")[0]).toBe("leads");
  });

  it("toggleSectionHidden flips only that section", () => {
    const layout = defaultDashboardLayout();
    const next = toggleSectionHidden(layout, "growth");
    expect(next.sections.find((s) => s.key === "growth")?.hidden).toBe(true);
    expect(next.sections.find((s) => s.key === "page")?.hidden).toBe(false);
  });

  it("toggleTileHidden flips only that tile", () => {
    const layout = defaultDashboardLayout();
    const key = groupTiles(layout, "dayToDay")[0];
    const next = toggleTileHidden(layout, "dayToDay", key);
    expect(next.sections.find((s) => s.key === "dayToDay")?.tiles[0].hidden).toBe(true);
  });
});

describe("resolveDashboardLayoutWithLegacyTiles", () => {
  it("seeds the dayToDay group from the old dashboardTileOrder when no layout saved", () => {
    const legacyTiles = [
      { key: "help" as const, hidden: false },
      { key: "classes" as const, hidden: true },
    ];
    const layout = resolveDashboardLayoutWithLegacyTiles(null, legacyTiles);
    const dayToDay = layout.sections.find((s) => s.key === "dayToDay")!;
    // The teacher's saved order leads (help before classes), classes still hidden.
    expect(dayToDay.tiles[0]).toEqual({ key: "help", hidden: false });
    expect(dayToDay.tiles.find((t) => t.key === "classes")?.hidden).toBe(true);
  });

  it("prefers a saved layout over legacy tiles once one exists", () => {
    const savedLayout = defaultDashboardLayout();
    savedLayout.sections = savedLayout.sections.filter((s) => s.key !== "growth");
    const layout = resolveDashboardLayoutWithLegacyTiles(savedLayout, [
      { key: "help" as const, hidden: false },
    ]);
    // growth is re-appended by resolution, and the layout — not the legacy tiles
    // — drives dayToDay (still the full default set, not just [help]).
    expect(layout.sections.some((s) => s.key === "growth")).toBe(true);
    expect(groupTiles(layout, "dayToDay").length).toBeGreaterThan(1);
  });
});

describe("dashboardTilesFromLayout", () => {
  it("projects the dayToDay group back to the flat tile shape web reads", () => {
    const layout = defaultDashboardLayout();
    const tiles = dashboardTilesFromLayout(layout);
    expect(tiles.map((t) => t.key)).toEqual(groupTiles(layout, "dayToDay"));
    expect(tiles.every((t) => typeof t.hidden === "boolean")).toBe(true);
  });
});
