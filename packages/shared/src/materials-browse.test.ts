import { describe, expect, it } from "vitest";
import {
  ALL_LEVELS,
  browseLevelFilter,
  browseLevelParam,
  groupMaterialsByLevel,
  resolveMaterialsBrowseMode,
} from "./materials-browse";

const LEVELS = ["lvl-a1", "lvl-a2", "lvl-b1"] as const;

describe("resolveMaterialsBrowseMode", () => {
  it("lands on the hub with nothing selected", () => {
    expect(resolveMaterialsBrowseMode({ levelIds: LEVELS })).toEqual({ kind: "hub" });
    expect(resolveMaterialsBrowseMode({ levelParam: null, levelIds: LEVELS })).toEqual({
      kind: "hub",
    });
    expect(resolveMaterialsBrowseMode({ levelParam: "", levelIds: LEVELS })).toEqual({
      kind: "hub",
    });
  });

  it("opens a shelf for one of the teacher's own levels", () => {
    expect(resolveMaterialsBrowseMode({ levelParam: "lvl-a2", levelIds: LEVELS })).toEqual({
      kind: "level",
      levelId: "lvl-a2",
    });
  });

  it("opens the flat list for the explicit all-levels sentinel", () => {
    expect(resolveMaterialsBrowseMode({ levelParam: ALL_LEVELS, levelIds: LEVELS })).toEqual({
      kind: "all",
    });
  });

  it("ignores a level that is not the teacher's own", () => {
    // Another teacher's id, or one that was archived since the link was made:
    // treated as no selection at all, not as an empty shelf.
    expect(
      resolveMaterialsBrowseMode({ levelParam: "lvl-someone-else", levelIds: LEVELS }),
    ).toEqual({ kind: "hub" });
  });

  it("still ignores a foreign level when other narrowing is active", () => {
    expect(
      resolveMaterialsBrowseMode({
        levelParam: "lvl-someone-else",
        levelIds: LEVELS,
        hasOtherNarrowing: true,
      }),
    ).toEqual({ kind: "all" });
  });

  // The regression that makes existing bookmarks/deep links survive the
  // redesign: a saved ?type=file or ?q=… URL carries no level, and must render
  // its filtered list rather than bouncing to a level picker that drops it.
  it("renders the list, not the hub, when another filter is already active", () => {
    expect(resolveMaterialsBrowseMode({ levelIds: LEVELS, hasOtherNarrowing: true })).toEqual({
      kind: "all",
    });
  });

  it("prefers a valid level over other narrowing", () => {
    expect(
      resolveMaterialsBrowseMode({
        levelParam: "lvl-b1",
        levelIds: LEVELS,
        hasOtherNarrowing: true,
      }),
    ).toEqual({ kind: "level", levelId: "lvl-b1" });
  });

  // A teacher with no Level rows can't be shown a level picker — the page's
  // own "no levels configured yet" card is the answer, and it renders on the
  // list branch.
  it("skips the hub when the teacher has no levels at all", () => {
    expect(resolveMaterialsBrowseMode({ levelIds: [] })).toEqual({ kind: "all" });
    expect(resolveMaterialsBrowseMode({ levelParam: "lvl-a1", levelIds: [] })).toEqual({
      kind: "all",
    });
  });
});

describe("browseLevelFilter", () => {
  it("filters only on a real shelf", () => {
    expect(browseLevelFilter({ kind: "level", levelId: "lvl-a2" })).toBe("lvl-a2");
    expect(browseLevelFilter({ kind: "all" })).toBeNull();
    expect(browseLevelFilter({ kind: "hub" })).toBeNull();
  });
});

describe("browseLevelParam", () => {
  it("round-trips a mode back into the selection that produced it", () => {
    for (const levelParam of [null, ALL_LEVELS, "lvl-a1"]) {
      const mode = resolveMaterialsBrowseMode({ levelParam, levelIds: LEVELS });
      expect(browseLevelParam(mode)).toBe(levelParam);
    }
  });

  it("keeps the list sticky — 'all' round-trips instead of dropping to the hub", () => {
    // The bug this guards: rendering the all-levels list with no `level` value
    // in the URL, so the very next filter click navigates back to the hub.
    expect(browseLevelParam({ kind: "all" })).toBe(ALL_LEVELS);
    expect(browseLevelParam({ kind: "hub" })).toBeNull();
  });
});

describe("groupMaterialsByLevel", () => {
  const opt = (id: string, levelId: string | null, levelLabel: string) => ({
    id,
    levelId,
    levelLabel,
  });

  it("buckets items under their level", () => {
    const groups = groupMaterialsByLevel(
      [opt("a", "lvl-a1", "A1"), opt("b", "lvl-a1", "A1"), opt("c", "lvl-b1", "B1")],
      "No level",
    );
    expect(groups.map((g) => g.levelLabel)).toEqual(["A1", "B1"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["c"]);
  });

  // The contract that makes this safe without passing the ladder in: callers
  // sort by `level: { position: "asc" }`, so encounter order IS ladder order.
  it("preserves first-encounter order rather than sorting by label", () => {
    // Deliberately reverse-alphabetical: a label sort would reorder these.
    const groups = groupMaterialsByLevel(
      [opt("a", "lvl-c1", "C1"), opt("b", "lvl-a1", "A1")],
      "No level",
    );
    expect(groups.map((g) => g.levelLabel)).toEqual(["C1", "A1"]);
  });

  it("re-joins a level whose items are not contiguous", () => {
    const groups = groupMaterialsByLevel(
      [opt("a", "lvl-a1", "A1"), opt("b", "lvl-b1", "B1"), opt("c", "lvl-a1", "A1")],
      "No level",
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("collects level-less items under the supplied label", () => {
    const groups = groupMaterialsByLevel([opt("a", null, "")], "No level");
    expect(groups).toEqual([
      { levelId: null, levelLabel: "No level", items: [opt("a", null, "")] },
    ]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupMaterialsByLevel([], "No level")).toEqual([]);
  });

  it("keys on levelId, not the display label, so duplicate labels stay apart", () => {
    // Level labels are not unique per teacher at the DB level — only
    // (teacherId, code) and (teacherId, position) are.
    const groups = groupMaterialsByLevel(
      [opt("a", "lvl-1", "Beginner"), opt("b", "lvl-2", "Beginner")],
      "No level",
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.levelId)).toEqual(["lvl-1", "lvl-2"]);
  });
});
