import { describe, expect, it } from "vitest";
import { ALL_LEVELS } from "@spiralclass/shared";
import {
  MATERIALS_PATH,
  materialsAllLevelsHref,
  materialsClearFiltersHref,
  materialsHref,
  materialsHubHref,
  materialsLevelHref,
  materialsPageParams,
  type MaterialsUrlState,
} from "./materials-href";

const base: MaterialsUrlState = {
  level: null,
  category: null,
  type: null,
  visibility: null,
  q: "",
  sort: "recent",
  view: "active",
};

const shelf: MaterialsUrlState = { ...base, level: "lvl-a2" };

describe("materialsHref", () => {
  it("emits a bare path when everything is at its default", () => {
    expect(materialsHref(base)).toBe(MATERIALS_PATH);
  });

  it("omits the default sort and view", () => {
    expect(materialsHref(base, { sort: "recent", view: "active" })).toBe(MATERIALS_PATH);
    expect(materialsHref(base, { sort: "name" })).toBe(`${MATERIALS_PATH}?sort=name`);
    expect(materialsHref(base, { view: "archived" })).toBe(`${MATERIALS_PATH}?view=archived`);
  });

  it("carries the current state forward across an override", () => {
    const state: MaterialsUrlState = { ...shelf, q: "past simple", sort: "name" };
    const href = materialsHref(state, { type: "file" });
    const params = new URL(href, "https://x.test").searchParams;
    expect(params.get("level")).toBe("lvl-a2");
    expect(params.get("type")).toBe("file");
    expect(params.get("q")).toBe("past simple");
    expect(params.get("sort")).toBe("name");
  });

  it("clears one axis with an explicit null without touching the others", () => {
    const state: MaterialsUrlState = { ...shelf, type: "file", category: "cat-1" };
    const params = new URL(materialsHref(state, { type: null }), "https://x.test").searchParams;
    expect(params.get("type")).toBeNull();
    expect(params.get("category")).toBe("cat-1");
    expect(params.get("level")).toBe("lvl-a2");
  });

  // The regression the whole module exists for. "All" on the level row used to
  // drop ?level= entirely; post-redesign a missing level means "show the hub",
  // so that same click would have ejected the teacher out of the list she was
  // filtering. It must emit the explicit sentinel instead.
  it("keeps the teacher in the list when she picks All on the level row", () => {
    const href = materialsHref({ ...shelf, type: "file" }, { level: ALL_LEVELS });
    const params = new URL(href, "https://x.test").searchParams;
    expect(params.get("level")).toBe(ALL_LEVELS);
    expect(params.get("type")).toBe("file");
  });

  it("never carries a page number — a changed axis restarts paging", () => {
    // `page` isn't part of the state at all, so no override can reintroduce it.
    expect(materialsHref({ ...shelf }, { type: "file" })).not.toContain("page=");
  });

  it("stays in the all-levels list when another filter changes there", () => {
    const state: MaterialsUrlState = { ...base, level: ALL_LEVELS };
    const params = new URL(materialsHref(state, { visibility: "exact" }), "https://x.test")
      .searchParams;
    expect(params.get("level")).toBe(ALL_LEVELS);
    expect(params.get("visibility")).toBe("exact");
  });
});

describe("hub and shelf entry points", () => {
  it("returns to the picker with every filter dropped", () => {
    // Deliberate: carrying a stale type/visibility chip into the next shelf
    // would silently hide materials the teacher just navigated to see.
    expect(materialsHubHref()).toBe(MATERIALS_PATH);
  });

  it("opens a shelf unfiltered", () => {
    expect(materialsLevelHref("lvl-b1")).toBe(`${MATERIALS_PATH}?level=lvl-b1`);
  });

  it("encodes a level id that needs it", () => {
    expect(materialsLevelHref("a b&c")).toBe(`${MATERIALS_PATH}?level=a%20b%26c`);
  });

  it("points the escape hatch at the all-levels sentinel", () => {
    expect(materialsAllLevelsHref()).toBe(`${MATERIALS_PATH}?level=${ALL_LEVELS}`);
  });
});

describe("materialsClearFiltersHref", () => {
  it("drops every narrowing axis", () => {
    const state: MaterialsUrlState = {
      ...shelf,
      category: "cat-grammar",
      type: "file",
      visibility: "exact",
      q: "past simple",
    };
    const params = new URL(materialsClearFiltersHref(state), "https://x.test").searchParams;
    expect(params.get("category")).toBeNull();
    expect(params.get("type")).toBeNull();
    expect(params.get("visibility")).toBeNull();
    expect(params.get("q")).toBeNull();
  });

  it("keeps the shelf she is standing on, so clearing widens rather than moves", () => {
    const state: MaterialsUrlState = {
      ...shelf,
      view: "archived",
      sort: "name",
      type: "link",
    };
    const params = new URL(materialsClearFiltersHref(state), "https://x.test").searchParams;
    expect(params.get("level")).toBe("lvl-a2");
    expect(params.get("view")).toBe("archived");
    expect(params.get("sort")).toBe("name");
  });

  it("keeps the all-levels list in the list — never back to the hub", () => {
    // The trap this whole module exists for: clearing filters from the flat
    // list must carry ALL_LEVELS forward, because a dropped `level` means hub.
    const state: MaterialsUrlState = { ...base, level: ALL_LEVELS, type: "content" };
    expect(materialsClearFiltersHref(state)).toBe(`${MATERIALS_PATH}?level=${ALL_LEVELS}`);
  });
});

describe("materialsPageParams", () => {
  it("carries the level so pagination doesn't fall out of the shelf", () => {
    // Page 2 of the A2 shelf must still be the A2 shelf; a dropped level here
    // would land page 2 on the hub.
    expect(materialsPageParams(shelf).level).toBe("lvl-a2");
    expect(materialsPageParams({ ...base, level: ALL_LEVELS }).level).toBe(ALL_LEVELS);
  });

  it("omits defaults and empty values so page links stay clean", () => {
    expect(materialsPageParams(base)).toEqual({
      level: undefined,
      category: undefined,
      type: undefined,
      visibility: undefined,
      q: undefined,
      sort: undefined,
      view: undefined,
    });
  });

  it("keeps non-default sort and view", () => {
    const params = materialsPageParams({ ...shelf, sort: "name", view: "archived", q: "x" });
    expect(params.sort).toBe("name");
    expect(params.view).toBe("archived");
    expect(params.q).toBe("x");
  });
});
